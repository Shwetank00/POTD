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

// --- 1. SESSION VALIDATOR ---
async function validateSession() {
  try {
    const response = await axios.post(
      "https://leetcode.com/graphql",
      {
        query: `
                    query globalData {
                        userStatus {
                            isSignedIn
                            username
                        }
                    }
                `,
      },
      {
        headers: {
          Cookie: `LEETCODE_SESSION=${USER_COOKIES.LEETCODE_SESSION}; csrftoken=${USER_COOKIES.csrftoken}`,
          Referer: "https://leetcode.com/",
          "Content-Type": "application/json",
        },
      }
    );

    const status = response.data.data.userStatus;
    if (status && status.isSignedIn) {
      return { valid: true, username: status.username };
    }
    return { valid: false };
  } catch (e) {
    console.error("Session Validation Error:", e.message);
    return { valid: false, error: e.message };
  }
}

// --- 2. UNIVERSAL SOLUTION FETCHER ---
async function getSolution(id, titleSlug) {
  try {
    const pathByID = path.join(__dirname, "solutions", `${id}.txt`);
    if (fs.existsSync(pathByID)) return fs.readFileSync(pathByID, "utf8");

    const pathByName = path.join(__dirname, "solutions", `${titleSlug}.cpp`);
    if (fs.existsSync(pathByName)) return fs.readFileSync(pathByName, "utf8");

    console.log(
      `🌐 Local file not found. Fetching from GitHub for: ${titleSlug}...`
    );
    const githubUrl = `https://raw.githubusercontent.com/kamyu104/LeetCode-Solutions/master/C++/${titleSlug}.cpp`;
    const response = await axios.get(githubUrl);

    if (response.status === 200 && response.data) {
      return response.data
        .replace(/\/\*[\s\S]*?\*\/|([^\\:]|^)\/\/.*$/gm, "$1")
        .trim();
    }
  } catch (e) {
    console.error(`❌ Failed to fetch solution for ${titleSlug}:`, e.message);
  }
  return null;
}

// --- 3. FETCH POTD ---
async function getDailyProblem() {
  try {
    const response = await axios.post(
      "https://leetcode.com/graphql",
      {
        query: `
                    query questionOfToday {
                        activeDailyCodingChallengeQuestion {
                            date
                            userStatus
                            link
                            question {
                                questionFrontendId
                                titleSlug
                            }
                        }
                    }
                `,
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

// --- 4. AUTOMATION LOGIC ---
async function solvePOTD() {
  if (isProcessing) {
    console.log("⚠️ Task already running. Skipping.");
    return;
  }
  isProcessing = true;
  console.log(`[${new Date().toISOString()}] --- Starting Task ---`);

  const session = await validateSession();
  if (!session.valid) {
    console.log("❌ ERROR: Credentials are invalid or expired.");
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
        "--no-first-run",
        "--no-zygote",
        "--single-process",
        "--disable-extensions",
        "--mute-audio",
      ],
    });

    const page = await browser.newPage();

    // Use a realistic User Agent
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    );

    await page.setRequestInterception(true);
    page.on("request", (req) => {
      if (
        ["image", "stylesheet", "font", "media"].includes(req.resourceType())
      ) {
        req.abort();
      } else {
        req.continue();
      }
    });

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

    await page.goto(`https://leetcode.com/problems/${titleSlug}/`, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });

    // --- NEW CLOUDFLARE HANDLER ---
    let pageTitle = await page.title();
    console.log(`📄 Page Title: "${pageTitle}"`);

    if (
      pageTitle.includes("Just a moment") ||
      pageTitle.includes("Security Check")
    ) {
      console.log(
        "⚠️ Cloudflare Challenge detected. Waiting for redirect (max 30s)..."
      );

      try {
        // Wait for the title to change to something else
        await page.waitForFunction(
          () => {
            const t = document.title;
            return (
              !t.includes("Just a moment") && !t.includes("Security Check")
            );
          },
          { timeout: 30000 }
        );

        pageTitle = await page.title();
        console.log(`✅ Passed Cloudflare! New Title: "${pageTitle}"`);
      } catch (e) {
        console.error("❌ Stuck on Cloudflare. Taking snapshot.");
        throw new Error("Blocked by Cloudflare - IP Flagged.");
      }
    }

    const editorSelector = ".monaco-editor";
    try {
      await page.waitForSelector(editorSelector, { timeout: 10000 });
    } catch (e) {
      console.log(
        "⚠️ Editor not found immediately. Scanning for 'Code' tab..."
      );

      const clicked = await page.evaluate(() => {
        const elements = [...document.querySelectorAll("div, span, button, p")];
        const codeTab = elements.find(
          (el) => el.innerText && el.innerText.trim() === "Code"
        );
        if (codeTab) {
          codeTab.click();
          return true;
        }
        return false;
      });

      if (clicked) {
        console.log("✅ Clicked 'Code' tab. Waiting for editor...");
        await new Promise((r) => setTimeout(r, 2000));
        await page.waitForSelector(editorSelector, { timeout: 15000 });
      } else {
        throw new Error("UI Mismatch: Could not find 'Code' tab.");
      }
    }

    await page.click(editorSelector);
    await page.keyboard.down("Control");
    await page.keyboard.press("A");
    await page.keyboard.up("Control");
    await page.keyboard.press("Backspace");
    await page.keyboard.sendCharacter(solutionCode);
    await new Promise((r) => setTimeout(r, 1000));

    const submitBtn = await page.evaluateHandle(() => {
      return Array.from(document.querySelectorAll("button")).find((b) =>
        b.innerText.includes("Submit")
      );
    });

    if (submitBtn) {
      await submitBtn.click();
      console.log("Submitted! Waiting for confirmation...");
      await new Promise((r) => setTimeout(r, 5000));
      console.log("✅ Submission sequence complete.");
    } else {
      console.error("❌ Submit button not found.");
    }
  } catch (e) {
    console.error("❌ Automation Error:", e.message);
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
  if (session.valid) {
    res.send(
      `✅ <strong>ONLINE</strong><br>Logged in as: <b>${session.username}</b>`
    );
  } else {
    res.send(
      `❌ <strong>OFFLINE</strong><br>Credentials invalid or expired.<br><br><a href="/">Update Credentials</a>`
    );
  }
});

app.get("/trigger", async (req, res) => {
  if (isProcessing) return res.send("⚠️ Task is already running!");
  solvePOTD();
  res.send("Task triggered. Check Render logs.");
});

app.post("/update-creds", (req, res) => {
  USER_COOKIES.LEETCODE_SESSION = req.body.session;
  USER_COOKIES.csrftoken = req.body.csrf;
  res.send("Credentials updated!");
});

cron.schedule("0 6 * * *", () => solvePOTD(), { timezone: "Asia/Kolkata" });

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
