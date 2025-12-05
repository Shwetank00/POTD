require("dotenv").config();
const express = require("express");
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const cron = require("node-cron");
const axios = require("axios");
const bodyParser = require("body-parser");
const fs = require("fs");
const vm = require("vm");

puppeteer.use(StealthPlugin());

const app = express();
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static("public"));

// --- GLOBAL STATE ---
let isProcessing = false; // LOCK: Prevents double execution
let USER_COOKIES = {
  LEETCODE_SESSION: process.env.LEETCODE_SESSION || "",
  csrftoken: process.env.CSRF_TOKEN || "",
};

// --- 1. MEMORY OPTIMIZED SOLUTION LOADER ---
// Instead of keeping the huge object in memory, we load, extract, and dump it.
// --- 1. SMART SOLUTION FETCHER (Local -> GitHub) ---
async function getSolution(id, titleSlug) {
  try {
    // STEP 1: Check Local File (solutions/ID.txt)
    const localPath = path.join(__dirname, "solutions", `${id}.txt`);
    if (fs.existsSync(localPath)) {
      console.log(`📂 Found local solution for ID: ${id}`);
      return fs.readFileSync(localPath, "utf8");
    }

    // STEP 2: Fetch from GitHub (kamyu104/LeetCode-Solutions)
    // Kamyu uses the exact title-slug for filenames, which is perfect for us.
    console.log(
      `🌐 Local file not found. Fetching from GitHub for: ${titleSlug}...`
    );

    const githubUrl = `https://raw.githubusercontent.com/kamyu104/LeetCode-Solutions/master/C++/${titleSlug}.cpp`;

    const response = await axios.get(githubUrl);

    if (response.status === 200 && response.data) {
      let code = response.data;

      // Clean up the code (remove comments to save space/time)
      // This regex removes block comments /* ... */ and line comments // ...
      code = code.replace(/\/\*[\s\S]*?\*\/|([^\\:]|^)\/\/.*$/gm, "$1").trim();

      // Optional: Save it locally so we don't need to fetch it next time
      // fs.writeFileSync(localPath, code);

      return code;
    }
  } catch (e) {
    console.error(`❌ Failed to fetch solution for ${titleSlug}:`, e.message);
  }
  return null;
}

// --- 2. FETCH POTD ---
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

// --- 3. OPTIMIZED AUTOMATION LOGIC ---
async function solvePOTD() {
  // 1. Check Lock
  if (isProcessing) {
    console.log("⚠️ Task already running. Skipping duplicate trigger.");
    return;
  }
  isProcessing = true; // Lock

  console.log(`[${new Date().toISOString()}] --- Starting Task ---`);

  // 2. Validate Cookies
  if (!USER_COOKIES.LEETCODE_SESSION || !USER_COOKIES.csrftoken) {
    console.log("❌ No credentials found.");
    isProcessing = false;
    return;
  }

  let browser = null;

  try {
    // 3. Get Problem
    const dailyData = await getDailyProblem();
    if (!dailyData) throw new Error("Could not fetch daily problem");

    if (dailyData.userStatus === "Finish") {
      console.log(`✅ Already Solved: ${dailyData.question.titleSlug}`);
      return; // Cleanup in finally block
    }

    const { questionFrontendId, titleSlug } = dailyData.question;

    // 4. Get Solution (Load -> Extract -> Release Memory)
    // We now pass both ID and TitleSlug
    const solutionCode = await getSolution(questionFrontendId, titleSlug);
    if (!solutionCode) {
      console.log(`❌ No solution found for ID: ${questionFrontendId}`);
      return;
    }

    console.log(`🚀 Solving: ${titleSlug} (ID: ${questionFrontendId})`);

    // 5. Launch Minimal Browser
    browser = await puppeteer.launch({
      headless: "new",
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage", // Uses disk instead of RAM for temp files
        "--disable-gpu", // Saves huge RAM
        "--no-first-run",
        "--no-zygote",
        "--single-process", // Required for Render
        "--disable-extensions",
        "--mute-audio",
      ],
    });

    const page = await browser.newPage();

    // --- CRITICAL: BLOCK IMAGES & FONTS (Saves ~100MB) ---
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

    // Authenticate
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

    // Navigate
    await page.goto(`https://leetcode.com/problems/${titleSlug}/`, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });

    // Find Editor
    console.log("Waiting for editor...");
    const editorSelector = ".monaco-editor";

    // Try fallback for "Code" tab if editor isn't visible immediately
    try {
      await page.waitForSelector(editorSelector, { timeout: 15000 });
    } catch (e) {
      console.log("Editor not found immediately, checking tabs...");
      const codeTab = await page.evaluateHandle(() => {
        return Array.from(document.querySelectorAll("div")).find(
          (el) => el.innerText === "Code"
        );
      });
      if (codeTab) await codeTab.click();
      await page.waitForSelector(editorSelector, { timeout: 15000 });
    }

    // Type Solution
    await page.click(editorSelector);

    // Mac/Windows compatible clear
    await page.keyboard.down("Control");
    await page.keyboard.press("A");
    await page.keyboard.up("Control");
    await page.keyboard.press("Backspace");

    await page.keyboard.sendCharacter(solutionCode);
    await new Promise((r) => setTimeout(r, 1000));

    // Submit
    const submitBtn = await page.evaluateHandle(() => {
      return Array.from(document.querySelectorAll("button")).find((b) =>
        b.innerText.includes("Submit")
      );
    });

    if (submitBtn) {
      await submitBtn.click();
      console.log("Submitted! Waiting for network confirmation...");
      // Wait briefly for network activity to settle, don't wait for full page reload to save RAM
      await new Promise((r) => setTimeout(r, 5000));
      console.log("✅ Submission sequence complete.");
    } else {
      console.error("❌ Submit button not found.");
    }
  } catch (e) {
    console.error("❌ Automation Error:", e.message);
  } finally {
    // 6. AGGRESSIVE CLEANUP
    if (browser) await browser.close();
    isProcessing = false; // Unlock
    if (global.gc) global.gc(); // Force Garbage Collection if exposed
    console.log(
      `[${new Date().toISOString()}] Task Finished. Memory released.`
    );
  }
}

// --- ROUTES ---

app.get("/ping", (req, res) => res.status(200).send("Pong!"));

app.get("/trigger", async (req, res) => {
  if (isProcessing) return res.send("⚠️ Task is already running! Check logs.");

  // Run in background, don't keep HTTP request waiting
  solvePOTD();
  res.send("Task triggered in background. Check Render logs.");
});

app.post("/update-creds", (req, res) => {
  USER_COOKIES.LEETCODE_SESSION = req.body.session;
  USER_COOKIES.csrftoken = req.body.csrf;
  res.send("Credentials updated!");
});

app.get("/debug", async (req, res) => {
  // Simplified debug to save RAM
  res.send("Debug screenshot disabled to save memory on free tier.");
});

// Schedule: 6:00 AM IST
cron.schedule("0 6 * * *", () => solvePOTD(), { timezone: "Asia/Kolkata" });

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
