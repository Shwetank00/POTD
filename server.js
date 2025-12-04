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
// Increase payload size limit just in case
app.use(express.json({ limit: "50mb" }));
app.use(express.static("public"));

// --- 1. Load solutions safely ---
function loadSolutions() {
  try {
    if (!fs.existsSync("./solutions.js")) return {};
    const code = fs.readFileSync("./solutions.js", "utf8");
    const sandbox = {};
    vm.createContext(sandbox);
    return vm.runInContext(code + "; LEETCODE_SOLUTIONS;", sandbox);
  } catch (e) {
    console.error("Error loading solutions:", e.message);
    return {};
  }
}

let USER_COOKIES = {
  LEETCODE_SESSION: process.env.LEETCODE_SESSION || "",
  csrftoken: process.env.CSRF_TOKEN || "",
};

// --- 2. Helper to fetch POTD ---
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

// --- 3. Main Automation Logic ---
async function solvePOTD() {
  console.log("--- Starting Daily Submission Task ---");
  const currentSolutions = loadSolutions();

  if (!USER_COOKIES.LEETCODE_SESSION || !USER_COOKIES.csrftoken) {
    console.log("Error: No credentials found.");
    return;
  }

  const dailyData = await getDailyProblem();
  if (!dailyData) return;

  if (dailyData.userStatus === "Finish") {
    console.log(
      `[SKIP] Today's problem (${dailyData.question.titleSlug}) is already finished.`
    );
    return;
  }

  const { questionFrontendId, titleSlug } = dailyData.question;
  const solutionCode = currentSolutions[questionFrontendId];

  if (!solutionCode) {
    console.log(`[FAIL] No solution found for ID: ${questionFrontendId}`);
    return;
  }

  console.log(`Solving POTD: ${titleSlug} (ID: ${questionFrontendId})`);

  // Launch Browser (Production / Docker Version)
  const browser = await puppeteer.launch({
    headless: "new", // Run in background (no window)
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--single-process", // Crucial for Docker
    ],
  });

  // // Launch Browser (Windows / Local Friendly Version)
  // const browser = await puppeteer.launch({
  //   // Set to 'false' so you can SEE the browser working!
  //   // Set to 'true' or '"new"' if you want it hidden.
  //   headless: false,
  //   args: [
  //     "--start-maximized", // Opens browser in full width
  //     // We REMOVED '--single-process' and '--no-sandbox' which cause crashes on Windows
  //   ],
  //   defaultViewport: null, // Allows the website to fill the window
  // });

  try {
    const page = await browser.newPage();

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
    console.log("Navigating to problem page...");
    await page.goto(`https://leetcode.com/problems/${titleSlug}/`, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });

    // LOGGING PAGE TITLE (Helps debug Cloudflare blocks)
    const pageTitle = await page.title();
    console.log(`Page Title loaded: "${pageTitle}"`);

    // WAIT STRATEGY: Try waiting for the editor OR the Code tab
    console.log("Waiting for editor...");

    try {
      // Try waiting for the specific editor class
      await page.waitForSelector(".monaco-editor", { timeout: 20000 });
    } catch (e) {
      console.log(
        "Standard editor selector failed. Trying to click 'Code' tab..."
      );
      // New UI Fallback: Sometimes we need to click the "Code" tab
      // This is a generic attempt to find a tab that looks like "Code"
      const codeTab = await page.evaluateHandle(() => {
        const divs = Array.from(document.querySelectorAll("div"));
        return divs.find((el) => el.innerText === "Code");
      });
      if (codeTab) {
        await codeTab.click();
        await new Promise((r) => setTimeout(r, 2000)); // Wait for tab switch
      }
    }

    // Final attempt to find editor after potential tab switch
    await page.click(".monaco-editor"); // This will throw error if still not found

    // Typing logic
    console.log("Editor found. Typing solution...");
    await page.keyboard.down("Control");
    await page.keyboard.press("A");
    await page.keyboard.up("Control");
    await page.keyboard.press("Backspace");
    await page.keyboard.sendCharacter(solutionCode);

    await new Promise((r) => setTimeout(r, 2000));

    console.log("Clicking Submit...");
    const submitBtn = await page.evaluateHandle(() => {
      const buttons = Array.from(document.querySelectorAll("button"));
      return buttons.find((b) => b.innerText.includes("Submit"));
    });

    if (submitBtn) {
      await submitBtn.click();
      console.log("Submitted! Waiting for network response...");
      await page
        .waitForNavigation({ waitUntil: "networkidle2", timeout: 60000 })
        .catch((e) =>
          console.log(
            "Navigation timeout (might be OK if submission recorded)."
          )
        );
    } else {
      console.error("Submit button not found.");
    }
  } catch (e) {
    console.error("Automation failed:", e.message);
  } finally {
    await browser.close();
  }
}

// --- 4. DEBUG ROUTE (THE FIX) ---
// Visit /debug to see exactly what the bot sees
app.get("/debug", async (req, res) => {
  console.log("Debug Screenshot triggered...");

  if (!USER_COOKIES.LEETCODE_SESSION)
    return res.send("Error: Set Environment Variables first.");

  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--window-size=1280,800",
    ],
  });

  try {
    const page = await browser.newPage();
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

    // Go to a known problem (Two Sum) to test access
    await page.goto("https://leetcode.com/problems/two-sum/", {
      waitUntil: "networkidle2",
      timeout: 60000,
    });

    // Capture Screenshot
    const screenshot = await page.screenshot();

    res.set("Content-Type", "image/png");
    res.send(screenshot);
  } catch (e) {
    res.send("Debug failed: " + e.message);
  } finally {
    await browser.close();
  }
});

// Routes
app.get("/ping", (req, res) => res.status(200).send("Pong!"));
app.post("/update-creds", (req, res) => {
  USER_COOKIES.LEETCODE_SESSION = req.body.session;
  USER_COOKIES.csrftoken = req.body.csrf;
  res.send("Updated!");
});
app.get("/trigger", async (req, res) => {
  solvePOTD();
  res.send("Triggered. Check logs.");
});
cron.schedule("0 6 * * *", () => solvePOTD(), { timezone: "Asia/Kolkata" });

const PORT = process.env.PORT || 10000; // Render usually uses 10000
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
