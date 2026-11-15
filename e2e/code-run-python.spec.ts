/**
 * code_run python (browser-side Pyodide) end to end: the run pauses with a `client` item, the page runs it in a worker,
 * reports the result, and continues — in a project chat started from the project page, in a normal chat, after the
 * SSE stream is cut, after a reload, and when Pyodide cannot load. Also: tool calls without a result never show
 * 執行中 once the run is no longer live.
 */
import { expect, test, type Page } from "@playwright/test";
import { createProject, ensureSetup, routePyodide, sql, toolResultFor } from "./support/setup";

const toolCard = (page: Page) => page.getByTestId("tool-card").first();

async function send(page: Page, text: string) {
  const box = page.getByPlaceholder(/輸入訊息/);
  await box.fill(text);
  await box.press("Enter");
}

async function newProjectChat(page: Page, name: string, permissionMode = "full") {
  const pid = await createProject(page, name, permissionMode);
  await page.goto(`/p/${pid}`);
  await page.getByRole("button", { name: "在專案中新對話" }).click();
  await expect(page).toHaveURL(/\/\?project=/);
  return pid;
}

async function expectCompleted(page: Page, prompt: string) {
  await expect(toolCard(page)).toHaveAttribute("data-state", "done", { timeout: 90_000 });
  await expect(page.getByText("Python 已執行完畢。")).toBeVisible();
  await expect(page.getByTestId("client-tool-card")).toHaveCount(0);
  const r = await toolResultFor(prompt);
  expect(r).toMatchObject({ ok: true, stdout: "ok\n" });
}

test.beforeEach(async ({ page, context }) => {
  await routePyodide(context);
  await ensureSetup(page);
});

test("project chat started from the project page runs Python in the browser and continues", async ({ page }) => {
  const prompt = `專案 Python ${Date.now()}`;
  await newProjectChat(page, `E2E 專案 ${Date.now()}`);
  await send(page, prompt);
  await expect(page).toHaveURL(/\/c\//);
  await expectCompleted(page, prompt);
});

test("normal mode: approval first, then the browser-side run", async ({ page }) => {
  const prompt = `一般模式 ${Date.now()}`;
  await newProjectChat(page, `E2E 一般 ${Date.now()}`, "normal");
  await send(page, prompt);
  await expect(toolCard(page)).toHaveAttribute("data-state", "waiting");
  await page.getByRole("button", { name: "允許一次" }).click();
  await expectCompleted(page, prompt);
});

test("non-project chat", async ({ page }) => {
  const prompt = `一般對話 ${Date.now()}`;
  await page.goto("/");
  await page.getByLabel("權限模式").selectOption("full");
  await send(page, prompt);
  await expectCompleted(page, prompt);
});

test("SSE stream cut before approval-required/done: the page resyncs and still runs the client tool", async ({ page, context }) => {
  const prompt = `斷線 ${Date.now()}`;
  let cut = false;
  await context.route("**/api/chat", async (route) => {
    if (cut) return route.continue();
    cut = true;
    const resp = await route.fetch();
    const body = await resp.text();
    // what a platform time limit / dropped connection looks like: a clean EOF right after the tool-call message
    await route.fulfill({ response: resp, body: body.slice(0, body.indexOf("event: approval-required")) });
  });
  await newProjectChat(page, `E2E 斷線 ${Date.now()}`);
  await send(page, prompt);
  await expectCompleted(page, prompt);
});

test("reload while the browser-side item is pending: it auto-starts again and completes", async ({ page, context }) => {
  const prompt = `重新整理 ${Date.now()}`;
  let hold = true;
  await context.route(/cdn\.jsdelivr\.net\/pyodide\//, async (route) => {
    if (hold) return; // never answers: Pyodide stays "loading"
    return route.fallback();
  });
  await newProjectChat(page, `E2E 重整 ${Date.now()}`);
  await send(page, prompt);
  await expect(page.getByTestId("client-tool-card")).toBeVisible();
  await expect(toolCard(page)).toHaveAttribute("data-state", "waiting");
  hold = false;
  await page.reload();
  await expectCompleted(page, prompt);
});

test("Pyodide cannot load: the failure is reported to the model and the run finishes", async ({ page, context }) => {
  const prompt = `無法載入 ${Date.now()}`;
  await context.route(/cdn\.jsdelivr\.net\/pyodide\//, (route) => route.fulfill({ status: 503, body: "offline" }));
  await newProjectChat(page, `E2E 離線 ${Date.now()}`);
  await send(page, prompt);
  await expect(toolCard(page)).toHaveAttribute("data-state", "error", { timeout: 60_000 });
  await expect(page.getByText("Python 已執行完畢。")).toBeVisible();
  const r = await toolResultFor(prompt);
  expect(r).toMatchObject({ ok: false });
  expect(String(r.error)).toContain("Pyodide");
});

test("a tool call whose run is gone shows 未完成（已中斷）; a paused run offers 繼續執行", async ({ page, context }) => {
  const prompt = `中斷 ${Date.now()}`;
  await context.route(/cdn\.jsdelivr\.net\/pyodide\//, () => {}); // keep the client item pending
  await newProjectChat(page, `E2E 中斷 ${Date.now()}`);
  await send(page, prompt);
  await expect(page.getByTestId("client-tool-card")).toBeVisible();
  const convId = page.url().split("/c/")[1];
  const [run] = await sql(`select id from runs where conversation_id = $1`, [convId]);

  // paused (e.g. between segments, nobody continued it): 已暫停 + 繼續執行 → the client item comes back and runs
  await sql(`update runs set status = 'paused' where id = $1`, [run.id]);
  await page.reload();
  await expect(toolCard(page)).toHaveAttribute("data-state", "paused");
  await expect(page.getByTestId("paused-run")).toBeVisible();

  // failed with no result for the call: never 執行中
  await sql(`update runs set status = 'failed', finished_at = now() where id = $1`, [run.id]);
  await page.reload();
  await expect(toolCard(page)).toHaveAttribute("data-state", "interrupted");
  await expect(toolCard(page)).toContainText("未完成（已中斷）");
  await expect(page.getByTestId("client-tool-card")).toHaveCount(0);

  // paused again → 繼續執行 resumes; with Pyodide reachable it completes
  await sql(`update runs set status = 'paused', finished_at = null where id = $1`, [run.id]);
  await context.unrouteAll({ behavior: "ignoreErrors" });
  await routePyodide(context);
  await page.reload();
  await page.getByRole("button", { name: "繼續執行" }).click();
  await expectCompleted(page, prompt);
});
