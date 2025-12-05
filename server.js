require("dotenv").config();
const express = require("express");
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const cron = require("node-cron");
const axios = require("axios");
const bodyParser = require("body-parser");
const fs = require("fs");
const path = require("path");

puppeteer.use(StealthPlugin());

const app = express();
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static("public"));

// --- GLOBAL STATE ---
let isProcessing = false;
let USER_COOKIES = {
  LEETCODE_SESSION: process.env.LEETCODE_SESSION || "",
  csrftoken: process.env.CSRF_TOKEN || "",
};

// --- HUMAN HELPER FUNCTIONS (The Magic) ---

// 1. Sleep for a random amount of time (e.g., between 2 and 5 seconds)
const randomDelay = (min = 1000, max = 3000) =>
  new Promise((resolve) =>
    setTimeout(resolve, Math.floor(Math.random() * (max - min + 1)) + min)
  );

// 2. Type like a human (variable speed)
async function humanType(page, selector, text) {
  await page.click(selector);
  for (const char of text) {
    await page.keyboard.sendCharacter(char);
    // Random delay between 50ms and 150ms per key
    await new Promise((r) => setTimeout(r, Math.random() * 100 + 50));
  }
}

// 3. Move mouse naturally and click
async function humanClick(page, selector) {
  const element = await page.$(selector);
  if (!element) throw new Error(`Element ${selector} not found`);

  const box = await element.boundingBox();
  const x = box.x + box.width / 2 + (Math.random() * 10 - 5); // Add jitter
  const y = box.y + box.height / 2 + (Math.random() * 10 - 5);

  // Move in steps to look real
  await page.mouse.move(x, y, { steps: 25 });
  await randomDelay(200, 600);
  await page.mouse.click(x, y);
}

// --- STANDARD FUNCTIONS ---

async function validateSession() {
  try {
    const response = await axios.post(
      "https://leetcode.com/graphql",
      { query: `query globalData { userStatus { isSignedIn username } }` },
      {
        headers: {
          Cookie: `LEETCODE_SESSION=${USER_COOKIES.LEETCODE_SESSION}; csrftoken=${USER_COOKIES.csrftoken}`,
          Referer: "https://leetcode.com/",
          "Content-Type": "application/json",
        },
      }
    );
    const status = response.data.data.userStatus;
    if (status && status.isSignedIn)
      return { valid: true, username: status.username };
    return { valid: false };
  } catch (e) {
    return { valid: false, error: e.message };
  }
}

async function getSolution(id, titleSlug) {
  try {
    const pathByID = path.join(__dirname, "solutions", `${id}.txt`);
    if (fs.existsSync(pathByID)) return fs.readFileSync(pathByID, "utf8");
    const pathByName = path.join(__dirname, "solutions", `${titleSlug}.cpp`);
    if (fs.existsSync(pathByName)) return fs.readFileSync(pathByName, "utf8");
    console.log(`🌐 Fetching from GitHub: ${titleSlug}...`);
    const githubUrl = `https://raw.githubusercontent.com/kamyu104/LeetCode-Solutions/master/C++/${titleSlug}.cpp`;
    const response = await axios.get(githubUrl);
    if (response.status === 200 && response.data)
      return response.data
        .replace(/\/\*[\s\S]*?\*\/|([^\\:]|^)\/\/.*$/gm, "$1")
        .trim();
  } catch (e) {
    console.error(`❌ GitHub Fetch Failed:`, e.message);
  }
  return null;
}

async function getDailyProblem() {
  try {
    const response = await axios.post(
      "https://leetcode.com/graphql",
      {
        query: `query questionOfToday { activeDailyCodingChallengeQuestion { date userStatus link question { questionFrontendId titleSlug } } }`,
      },
      {
        headers: {
          Cookie: `LEETCODE_SESSION=${USER_COOKIES.LEETCODE_SESSION}; csrftoken=${USER_COOKIES.csrftoken}`,
          Referer: "https://leetcode.com/",
          "Content-Type": "application/json",
        },
      }
    );
    return response.data.data.activeDailyCodingChallengeQuestion;
  } catch (error) {
    console.error("Error fetching POTD:", error.message);
    return null;
  }
}

// --- 4. MAIN LOGIC (UPDATED) ---
async function solvePOTD() {
  if (isProcessing) return;
  isProcessing = true;
  console.log(`[${new Date().toISOString()}] --- Starting Human-Like Task ---`);

  const session = await validateSession();
  if (!session.valid) {
    console.log("❌ ERROR: Credentials invalid.");
    isProcessing = false;
    return;
  }
  console.log(`✅ Logged in as: ${session.username}`);

  let browser = null;

  try {
    const dailyData = await getDailyProblem();
    if (!dailyData) throw new Error("Could not fetch daily problem");

    if (dailyData.userStatus === "Finish") {
      console.log(`✅ Already Solved: ${dailyData.question.titleSlug}`);
      return;
    }

    const { questionFrontendId, titleSlug } = dailyData.question;
    const solutionCode = await getSolution(questionFrontendId, titleSlug);

    if (!solutionCode) {
      console.log(`❌ No solution found for ID: ${questionFrontendId}`);
      return;
    }

    console.log(`🚀 Solving: ${titleSlug} (ID: ${questionFrontendId})`);

    browser = await puppeteer.launch({
      headless: "new",
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--single-process",
      ],
    });

    const page = await browser.newPage();
    // High-res screen looks more human
    await page.setViewport({ width: 1920, height: 1080 });
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    );

    await page.setCookie(
      {
        name: "LEETCODE_SESSION",
        value: USER_COOKIES.LEETCODE_SESSION,
        domain: ".leetcode.com",
      },
      {
        name: "csrftoken",
        value: USER_COOKIES.csrftoken,
        domain: ".leetcode.com",
      }
    );

    // 1. Visit Homepage First
    console.log("🌍 Visiting Homepage...");
    await page.goto("https://leetcode.com/", { waitUntil: "domcontentloaded" });
    await randomDelay(2000, 4000);

    // 2. Go to Problem
    console.log(`➡️ Navigating to Problem...`);
    await page.goto(`https://leetcode.com/problems/${titleSlug}/`, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });

    // --- CLOUDFLARE HANDLER (WITH HUMAN MOUSE) ---
    let pageTitle = await page.title();
    if (
      pageTitle.includes("Just a moment") ||
      pageTitle.includes("Security Check")
    ) {
      console.log("⚠️ Cloudflare detected. Engaging human behavior...");
      try {
        await randomDelay(3000, 5000);

        // Jiggle mouse to show life
        await page.mouse.move(100, 100);
        await page.mouse.move(200, 200, { steps: 20 });

        // Find iframe and click box
        const frames = page.frames();
        const challengeFrame = frames.find(
          (f) => f.url().includes("cloudflare") || f.url().includes("challenge")
        );

        if (challengeFrame) {
          const checkbox = await challengeFrame.$('input[type="checkbox"]');
          if (checkbox) {
            const box = await checkbox.boundingBox();
            const x = box.x + box.width / 2;
            const y = box.y + box.height / 2;
            console.log("🖱️ Clicking Cloudflare Checkbox...");
            await page.mouse.move(x, y, { steps: 50 }); // Slow move
            await randomDelay(200, 500);
            await page.mouse.click(x, y);
          }
        }

        await page.waitForFunction(
          () => !document.title.includes("Just a moment"),
          { timeout: 30000 }
        );
        console.log("✅ Passed Cloudflare!");
      } catch (e) {
        console.error("❌ Cloudflare blocked us.");
        throw new Error("Cloudflare Block");
      }
    }

    // 3. Simulate "Reading" the question
    console.log("📖 Reading question...");
    const editorSelector = ".monaco-editor";
    try {
      await page.waitForSelector(editorSelector, { timeout: 15000 });
    } catch (e) {
      // Click Code tab if needed
      const divs = await page.$$("div");
      for (const div of divs) {
        const text = await page.evaluate((el) => el.innerText, div);
        if (text === "Code") {
          await humanClick(page, "div"); // Click like a human
          break;
        }
      }
      await page.waitForSelector(editorSelector, { timeout: 10000 });
    }

    // 4. Type Solution
    console.log("✍️ Typing solution...");
    await page.click(editorSelector);
    await page.keyboard.down("Control");
    await page.keyboard.press("A");
    await page.keyboard.up("Control");
    await page.keyboard.press("Backspace");

    // This actually types it character by character now
    await humanType(page, ".monaco-editor textarea", solutionCode);

    await randomDelay(1000, 3000); // Hesitate before submitting

    // 5. Submit
    const submitBtn = await page.evaluateHandle(() =>
      Array.from(document.querySelectorAll("button")).find((b) =>
        b.innerText.includes("Submit")
      )
    );
    if (submitBtn) {
      const btnBox = await submitBtn.boundingBox();
      if (btnBox) {
        await page.mouse.move(btnBox.x + 10, btnBox.y + 10, { steps: 20 });
        await randomDelay(500, 1000);
        await page.mouse.down();
        await randomDelay(50, 150);
        await page.mouse.up();
        console.log("✅ Clicked Submit.");
      } else {
        await submitBtn.click(); // Fallback
      }

      console.log("Submitted! Waiting...");
      await new Promise((r) => setTimeout(r, 5000));
      console.log("✅ Complete.");
    } else {
      console.error("❌ Submit button missing.");
    }
  } catch (e) {
    console.error("❌ Error:", e.message);
  } finally {
    if (browser) await browser.close();
    isProcessing = false;
    if (global.gc) global.gc();
    console.log(`[${new Date().toISOString()}] Task Finished.`);
  }
}

// --- ROUTES ---
app.get("/ping", (req, res) => res.status(200).send("Pong!"));
app.get("/status", async (req, res) => {
  const session = await validateSession();
  res.send(session.valid ? `✅ ONLINE: ${session.username}` : `❌ OFFLINE`);
});
app.get("/trigger", async (req, res) => {
  if (isProcessing) return res.send("⚠️ Task is already running!");
  solvePOTD();
  res.send("Task triggered. Check Logs.");
});
app.post("/update-creds", (req, res) => {
  USER_COOKIES.LEETCODE_SESSION = req.body.session;
  USER_COOKIES.csrftoken = req.body.csrf;
  res.send("Credentials updated!");
});

cron.schedule("0 6 * * *", () => solvePOTD(), { timezone: "Asia/Kolkata" });

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
