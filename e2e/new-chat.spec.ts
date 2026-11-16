/**
 * Regression for 「非專案中又無法建立對話」: every way to start a conversation outside a project — typing on the empty
 * chat page, the sidebar 新對話 button, after a project page / project chat, after deleting the open conversation, in
 * each global permission mode — and the two root causes:
 *  1. router navigations ran as React transitions: after 新對話 the previous conversation stayed on screen and
 *     interactive until the new route rendered, so a message typed right away was appended to the previous (often
 *     project) conversation and no new conversation was created;
 *  2. a global default model removed since: the page sent the stale id and POST /api/chat answered 400
 *     「找不到指定的模型」.
 * Messages are sent right after the URL changes (no waiting for the empty-state heading) on purpose.
 */
import { expect, test, type Page } from "@playwright/test";
import { api, createProject, ensureSetup, MOCK_LLM } from "./support/setup";

const errors: string[] = [];

async function send(page: Page, text: string) {
  const box = page.getByPlaceholder(/輸入訊息/);
  await expect(box).toBeEnabled();
  await box.fill(text);
  await box.press("Enter");
}

/** Sends a first message and checks a non-project conversation with the reply exists and is listed. */
async function startNonProjectChat(page: Page, label: string) {
  const prompt = `純文字 ${label} ${Date.now()}`;
  await send(page, prompt);
  await expect(page).toHaveURL(/\/c\/[0-9a-f-]{36}$/);
  await expect(page.getByText("收到。")).toBeVisible();
  const id = page.url().split("/c/")[1];
  const conv = await api(page, `/conversations/${id}`);
  expect(conv.projectId).toBeNull();
  await expect(sidebar(page).locator(`a[href="/c/${id}"]`)).toBeVisible(); // sidebar history (title may be auto-renamed)
  return id;
}

const sidebar = (page: Page) => page.locator("aside").first(); // desktop sidebar (the second <aside> is the mobile drawer)
const newChatButton = (page: Page) => sidebar(page).getByRole("button", { name: "新對話" });

test.beforeEach(async ({ page }) => {
  errors.length = 0;
  page.on("response", async (r) => {
    if (r.url().endsWith("/api/chat") && r.status() >= 400) errors.push(`${r.status()} ${await r.text().catch(() => "")}`);
  });
  await ensureSetup(page);
  await api(page, "/permissions/mode", "PUT", { scope: "global", mode: "normal" });
});

test.afterEach(() => {
  expect(errors, "POST /api/chat must not be refused").toEqual([]);
});

test("empty chat page and sidebar 新對話", async ({ page }) => {
  await page.goto("/");
  await startNonProjectChat(page, "首頁");
  await newChatButton(page).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("heading", { name: "今天想做什麼？" })).toBeVisible();
  await startNonProjectChat(page, "側邊欄");
});

test("after a project page and a project chat, a new chat is not in the project", async ({ page }) => {
  const pid = await createProject(page, `E2E 新對話 ${Date.now()}`);
  await page.goto(`/p/${pid}`);
  await page.getByRole("button", { name: "在專案中新對話" }).click();
  await expect(page).toHaveURL(/\/\?project=/);
  await send(page, `純文字 專案內 ${Date.now()}`);
  await expect(page).toHaveURL(/\/c\//);
  await expect(page.getByText("收到。")).toBeVisible();
  const inProject = await api(page, `/conversations/${page.url().split("/c/")[1]}`);
  expect(inProject.projectId).toBe(pid);

  await newChatButton(page).click();
  await expect(page).toHaveURL(/\/$/);
  await startNonProjectChat(page, "專案之後");

  // project draft that was never sent → 新對話
  await page.goto(`/p/${pid}`);
  await page.getByRole("button", { name: "在專案中新對話" }).click();
  await expect(page).toHaveURL(/\/\?project=/);
  await newChatButton(page).click();
  await expect(page).toHaveURL(/\/$/);
  await startNonProjectChat(page, "專案草稿之後");
});

test("after deleting the open conversation", async ({ page }) => {
  await page.goto("/");
  const id = await startNonProjectChat(page, "將刪除");
  const item = sidebar(page).locator("div.group", { has: page.locator(`a[href="/c/${id}"]`) });
  await item.hover();
  await item.getByRole("button", { name: "對話選項" }).click();
  await page.getByRole("menuitem", { name: "刪除" }).click();
  await page.getByRole("button", { name: "刪除" }).click();
  await expect(page).toHaveURL(/\/$/);
  await startNonProjectChat(page, "刪除之後");
});

test("every global permission mode", async ({ page }) => {
  for (const mode of ["plan", "normal", "auto_edit", "full", "custom"]) {
    await api(page, "/permissions/mode", "PUT", { scope: "global", mode });
    await page.goto("/");
    await startNonProjectChat(page, `全域 ${mode}`);
  }
  await page.goto("/");
  await page.getByLabel("權限模式").selectOption("plan");
  await startNonProjectChat(page, "對話 plan");
});

test("the global default model was removed since (stale settings reference)", async ({ page }) => {
  const prov = await api(page, "/providers", "POST", { type: "llm", kind: "openai", name: `暫時 ${Date.now()}`, baseUrl: `${MOCK_LLM}/v1` });
  const [m] = await api(page, `/providers/${prov.id}/models`, "PUT", { models: [{ modelId: "gone-model", capabilities: { tools: true } }] });
  await api(page, "/settings/agent", "PUT", { defaultModelId: m.id });

  // a page loaded while that model existed keeps the old default in memory
  await page.goto("/");
  await expect(page.getByLabel("模型")).toHaveValue(m.id);
  await api(page, `/providers/${prov.id}`, "DELETE");
  await startNonProjectChat(page, "舊頁面");

  // a fresh load never offers the removed model
  await page.goto("/");
  await expect(page.getByLabel("模型")).not.toHaveValue(m.id);
  expect((await api(page, "/settings/agent")).defaultModelId).toBeNull();
  await startNonProjectChat(page, "預設模型已移除");
});

test("a slow load of the previous project conversation never turns the new chat into a project chat", async ({ page, context }) => {
  const pid = await createProject(page, `E2E 慢載入 ${Date.now()}`);
  await page.goto(`/?project=${pid}`);
  await send(page, `純文字 慢載入專案 ${Date.now()}`);
  await expect(page).toHaveURL(/\/c\//);
  await expect(page.getByText("收到。")).toBeVisible();
  const projectConv = page.url().split("/c/")[1];
  await page.goto("/");

  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  await context.route(`**/api/conversations/${projectConv}/messages`, async (route) => {
    await held;
    await route.continue();
  });
  await sidebar(page).locator(`a[href="/c/${projectConv}"]`).click(); // its messages are still loading…
  await newChatButton(page).click(); // …when the user starts a new chat
  await expect(page).toHaveURL(/\/$/);
  release();
  await page.waitForResponse((r) => r.url().endsWith(`/conversations/${projectConv}/messages`));
  await page.waitForTimeout(500); // let the late response reach React
  await expect(page.getByRole("heading", { name: "今天想做什麼？" })).toBeVisible();
  await expect(page.getByText("收到。")).toHaveCount(0);
  await startNonProjectChat(page, "慢載入之後");
});
