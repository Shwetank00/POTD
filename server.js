const express = require("express");
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const cron = require("node-cron");
const axios = require("axios");
const bodyParser = require("body-parser");
const fs = require("fs"); // access file system
const vm = require("vm"); // execute code in memory

puppeteer.use(StealthPlugin());

const app = express();
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static("public"));

// --- NEW: Load solutions without modifying the file ---
function loadSolutions() {
  try {
    // 1. Read the file content as a string
    const code = fs.readFileSync("./solutions.js", "utf8");

    // 2. Create a sandbox (an empty context)
    const sandbox = {};
    vm.createContext(sandbox);

    // 3. Run the code in the sandbox.
    // We append "; LEETCODE_SOLUTIONS;" to the end so the script returns the object.
    return vm.runInContext(code + "; LEETCODE_SOLUTIONS;", sandbox);
  } catch (e) {
    console.error("Error loading solutions.js:", e.message);
    return {}; // Return empty object if failed
  }
}

const solutions = loadSolutions();
// -------------------------------------------------------

let USER_COOKIES = {
  LEETCODE_SESSION: process.env.LEETCODE_SESSION || "",
  csrftoken: process.env.CSRF_TOKEN || "",
};

// 1. Helper to get today's POTD ID
async function getDailyProblem() {
  try {
    const response = await axios.post("https://leetcode.com/graphql", {
      query: `
                query questionOfToday {
                    activeDailyCodingChallengeQuestion {
                        question {
                            questionFrontendId
                            titleSlug
                        }
                    }
                }
            `,
    });
    return response.data.data.activeDailyCodingChallengeQuestion.question;
  } catch (error) {
    console.error("Error fetching POTD:", error.message);
    return null;
  }
}

// 2. The Automation Logic
async function solvePOTD() {
  console.log("Starting Daily Submission Task...");

  // Refresh solutions in case file changed (optional)
  const currentSolutions = loadSolutions();

  if (!USER_COOKIES.LEETCODE_SESSION || !USER_COOKIES.csrftoken) {
    console.log("No credentials found. Skipping.");
    return;
  }

  const problem = await getDailyProblem();
  if (!problem) return;

  const { questionFrontendId, titleSlug } = problem;
  const solutionCode = currentSolutions[questionFrontendId];

  if (!solutionCode) {
    console.log(
      `No solution found locally for Problem ID: ${questionFrontendId}`
    );
    return;
  }

  console.log(`Solving POTD: ${titleSlug} (ID: ${questionFrontendId})`);

  // Launch Browser
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const page = await browser.newPage();

  // Set authentication cookies
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

  try {
    await page.goto(`https://leetcode.com/problems/${titleSlug}/`, {
      waitUntil: "networkidle2",
    });

    // Wait for editor
    await page.waitForSelector(".monaco-editor");
    await page.click(".monaco-editor");

    // Select all and delete
    await page.keyboard.down("Control");
    await page.keyboard.press("A");
    await page.keyboard.up("Control");
    await page.keyboard.press("Backspace");

    // Type solution
    await page.keyboard.sendCharacter(solutionCode);

    // Small delay
    await new Promise((r) => setTimeout(r, 2000));

    // Click Submit
    const submitBtn = await page.evaluateHandle(() => {
      const buttons = Array.from(document.querySelectorAll("button"));
      return buttons.find((b) => b.innerText.includes("Submit"));
    });

    if (submitBtn) {
      await submitBtn.click();
      console.log("Submitted! Waiting for result...");
      await page.waitForNavigation({ waitUntil: "networkidle2" });
    } else {
      console.error("Submit button not found.");
    }
  } catch (e) {
    console.error("Automation failed:", e);
  } finally {
    await browser.close();
  }
}

// Routes
app.post("/update-creds", (req, res) => {
  USER_COOKIES.LEETCODE_SESSION = req.body.session;
  USER_COOKIES.csrftoken = req.body.csrf;
  console.log("Credentials updated!");
  res.send("Credentials updated! The bot will run at 6 AM.");
});

app.get("/trigger", async (req, res) => {
  await solvePOTD();
  res.send("Task triggered. Check server logs.");
});

// Schedule: 6:00 AM UTC
cron.schedule(
  "0 6 * * *",
  () => {
    solvePOTD();
  },
  { timezone: "Etc/UTC" }
);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
