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

// --- 1. SESSION VALIDATOR (NEW) ---
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

// --- 2. SMART SOLUTION FETCHER ---
async function getSolution(id, titleSlug) {
  try {
    // Check Local
    const localPath = path.join(__dirname, "solutions", `${id}.txt`);
    if (fs.existsSync(localPath)) {
      console.log(`📂 Found local solution for ID: ${id}`);
      return fs.readFileSync(localPath, "utf8");
    }

    // Check GitHub
    console.log(
      `🌐 Local file not found. Fetching from GitHub for: ${titleSlug}...`
    );
    const githubUrl = `https://raw.githubusercontent.com/kamyu104/LeetCode-Solutions/master/C++/${titleSlug}.cpp`;
    const response = await axios.get(githubUrl);

    if (response.status === 200 && response.data) {
      let code = response.data;
      code = code.replace(/\/\*[\s\S]*?\*\/|([^\\:]|^)\/\/.*$/gm, "$1").trim();
      return code;
    }
  } catch (e) {
    console.error(
      `❌ Failed to fetch solution for ${titleSlug} (GitHub):`,
      e.message
    );
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

  // STEP A: Validate Session First
  const session = await validateSession();
  if (!session.valid) {
    console.log(
      "❌ ERROR: Credentials are invalid or expired. Please update them."
    );
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

    const editorSelector = ".monaco-editor";
    try {
      await page.waitForSelector(editorSelector, { timeout: 15000 });
    } catch (e) {
      console.log("Checking for Code tab...");
      const codeTab = await page.evaluateHandle(() => {
        return Array.from(document.querySelectorAll("div")).find(
          (el) => el.innerText === "Code"
        );
      });
      if (codeTab) await codeTab.click();
      await page.waitForSelector(editorSelector, { timeout: 15000 });
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
      console.log("Submitted! Waiting for network confirmation...");
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

// NEW: Status Check Endpoint
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
  res.send("Task triggered. Check Render logs for progress.");
});

app.post("/update-creds", (req, res) => {
  USER_COOKIES.LEETCODE_SESSION = req.body.session;
  USER_COOKIES.csrftoken = req.body.csrf;
  res.send("Credentials updated! <a href='/status'>Check Status</a>");
});

// Schedule: 6:00 AM IST
cron.schedule("0 6 * * *", () => solvePOTD(), { timezone: "Asia/Kolkata" });

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
