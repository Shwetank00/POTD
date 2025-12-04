const express = require("express");
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const cron = require("node-cron");
const axios = require("axios");
const bodyParser = require("body-parser");
const fs = require("fs");
const vm = require("vm");

// Enable stealth mode to avoid detection
puppeteer.use(StealthPlugin());

const app = express();
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static("public"));

// ---------------------------------------------------------
// 1. DYNAMIC SOLUTION LOADER
// Reads your solutions.js file without modifying it
// ---------------------------------------------------------
function loadSolutions() {
  try {
    if (!fs.existsSync("./solutions.js")) {
      console.error("solutions.js file not found!");
      return {};
    }
    const code = fs.readFileSync("./solutions.js", "utf8");
    const sandbox = {};
    vm.createContext(sandbox);
    // Execute the file string and return the LEETCODE_SOLUTIONS object
    return vm.runInContext(code + "; LEETCODE_SOLUTIONS;", sandbox);
  } catch (e) {
    console.error("Error loading solutions.js:", e.message);
    return {};
  }
}

// Global Credentials (loaded from Environment Variables on Render)
let USER_COOKIES = {
  LEETCODE_SESSION: process.env.LEETCODE_SESSION || "",
  csrftoken: process.env.CSRF_TOKEN || "",
};

// ---------------------------------------------------------
// 2. HELPER: FETCH POTD & CHECK STATUS
// ---------------------------------------------------------
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
        // Cookies are required here to check YOUR specific userStatus
        headers: {
          Cookie: `LEETCODE_SESSION=${USER_COOKIES.LEETCODE_SESSION}; csrftoken=${USER_COOKIES.csrftoken}`,
          Referer: "https://leetcode.com/",
          "Content-Type": "application/json",
        },
      }
    );
    return response.data.data.activeDailyCodingChallengeQuestion;
  } catch (error) {
    console.error("Error fetching POTD details:", error.message);
    return null;
  }
}

// ---------------------------------------------------------
// 3. MAIN LOGIC: SOLVE THE PROBLEM
// ---------------------------------------------------------
async function solvePOTD() {
  console.log("--- Starting Daily Submission Task ---");

  // Reload solutions in case you updated the file
  const currentSolutions = loadSolutions();

  // Validation
  if (!USER_COOKIES.LEETCODE_SESSION || !USER_COOKIES.csrftoken) {
    console.log(
      "Error: No credentials found. Please set Environment Variables or use the frontend."
    );
    return;
  }

  // Get Problem Data
  const dailyData = await getDailyProblem();
  if (!dailyData) return;

  // CHECK: If already solved, stop here.
  if (dailyData.userStatus === "Finish") {
    console.log(
      `[SKIP] Today's problem (${dailyData.question.titleSlug}) is already marked as 'Finish'.`
    );
    return;
  }

  const { questionFrontendId, titleSlug } = dailyData.question;
  const solutionCode = currentSolutions[questionFrontendId];

  // CHECK: Do we have the code?
  if (!solutionCode) {
    console.log(
      `[FAIL] No solution found in solutions.js for Problem ID: ${questionFrontendId}`
    );
    return;
  }

  console.log(`Solving: ${titleSlug} (ID: ${questionFrontendId})`);

  // Launch Browser
  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--single-process", // Optimization for Docker
    ],
  });

  try {
    const page = await browser.newPage();

    // Inject Cookies
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

    // Go to Problem Page
    await page.goto(`https://leetcode.com/problems/${titleSlug}/`, {
      waitUntil: "networkidle2",
      timeout: 60000,
    });

    // Wait for Editor
    console.log("Waiting for editor...");
    const editorSelector = ".monaco-editor";
    await page.waitForSelector(editorSelector, { timeout: 30000 });
    await page.click(editorSelector);

    // Clear existing code
    await page.keyboard.down("Control");
    await page.keyboard.press("A");
    await page.keyboard.up("Control");
    await page.keyboard.press("Backspace");

    // Type new solution
    console.log("Typing solution...");
    await page.keyboard.sendCharacter(solutionCode);

    // Delay to ensure typing registers
    await new Promise((r) => setTimeout(r, 2000));

    // Click Submit
    console.log("Clicking Submit...");
    const submitBtn = await page.evaluateHandle(() => {
      const buttons = Array.from(document.querySelectorAll("button"));
      return buttons.find((b) => b.innerText.includes("Submit"));
    });

    if (submitBtn) {
      await submitBtn.click();
      console.log("Submitted! Waiting for network response...");
      // Wait for the result/submission confirmation
      await page
        .waitForNavigation({ waitUntil: "networkidle2", timeout: 60000 })
        .catch(() => console.log("Navigation timeout, but likely submitted."));
      console.log("Task Completed Successfully.");
    } else {
      console.error("Error: Submit button not found on page.");
    }
  } catch (e) {
    console.error("Automation Error:", e);
  } finally {
    await browser.close();
  }
}

// ---------------------------------------------------------
// 4. ROUTES
// ---------------------------------------------------------

// PING Route (For UptimeRobot to keep server awake)
app.get("/ping", (req, res) => {
  console.log(`[${new Date().toISOString()}] Ping received.`);
  res.status(200).send("Pong! Server is awake.");
});

// Manual Trigger (For testing)
app.get("/trigger", async (req, res) => {
  // Run asynchronously so the request doesn't time out
  solvePOTD();
  res.send("Automation triggered! Check Render logs for progress.");
});

// Frontend Form Handler (Fallback for manual cookie updates)
app.post("/update-creds", (req, res) => {
  USER_COOKIES.LEETCODE_SESSION = req.body.session;
  USER_COOKIES.csrftoken = req.body.csrf;
  console.log("Credentials manually updated via frontend.");
  res.send("Credentials updated!");
});

// ---------------------------------------------------------
// 5. CRON SCHEDULE
// Runs at 06:00 AM IST (India Standard Time)
// ---------------------------------------------------------
cron.schedule(
  "0 6 * * *",
  () => {
    solvePOTD();
  },
  {
    scheduled: true,
    timezone: "Asia/Kolkata",
  }
);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
