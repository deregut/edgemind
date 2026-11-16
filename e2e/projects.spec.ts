/**
 * Regression for 「點擊專案，專案對話歷史爲空，舊對話不在專案中載入…歷史對話和專案混在一起」:
 *  - opening a project continues its most recent conversation (its history is shown), a new project chat is explicit;
 *  - the sidebar 最近對話 lists only conversations outside projects; project conversations sit under their project;
 *  - old conversations can be moved into / out of a project (sidebar menu and the project page).
 */
import { expect, test, type Page } from "@playwright/test";
import { api, createProject, ensureSetup } from "./support/setup";

const sidebar = (page: Page) => page.locator("aside").first();
const recentSection = (page: Page) => sidebar(page).locator('[data-section="最近對話"]');
const projectNode = (page: Page, pid: string) => sidebar(page).locator(`[data-project-id="${pid}"]`);

async function send(page: Page, text: string) {
  const box = page.getByPlaceholder(/輸入訊息/);
  await expect(box).toBeEnabled();
  await box.fill(text);
  await box.press("Enter");
}

async function chat(page: Page, text: string) {
  await send(page, text);
  await expect(page).toHaveURL(/\/c\/[0-9a-f-]{36}$/);
  await expect(page.getByText("收到。").last()).toBeVisible();
  return page.url().split("/c/")[1];
}

test.beforeEach(async ({ page }) => {
  await ensureSetup(page);
  await api(page, "/permissions/mode", "PUT", { scope: "global", mode: "normal" });
});

test("opening a project continues its latest conversation; history is not mixed with projects", async ({ page }) => {
  const stamp = Date.now();
  const pid = await createProject(page, `E2E 專案 ${stamp}`);
  const empty = await createProject(page, `E2E 空專案 ${stamp}`);

  await page.goto("/");
  const loose = await chat(page, `純文字 專案外 ${stamp}`);

  // explicit new chat inside the project
  await page.goto(`/p/${pid}`);
  await page.getByRole("button", { name: "在專案中新對話" }).click();
  await expect(page).toHaveURL(new RegExp(`/\\?project=${pid}$`));
  const first = await chat(page, `純文字 專案第一個 ${stamp}`);
  expect((await api(page, `/conversations/${first}`)).projectId).toBe(pid);
  await page.goto(`/?project=${pid}`);
  await expect(page.getByTestId("project-recent").locator(`a[href="/c/${first}"]`)).toBeVisible(); // offered on the empty project chat
  const latest = await chat(page, `純文字 專案第二個 ${stamp}`);
  expect((await api(page, `/conversations/${latest}`)).projectId).toBe(pid);

  // sidebar: project conversations only under the project; 最近對話 only outside projects
  await page.goto("/");
  await expect(recentSection(page).locator(`a[href="/c/${loose}"]`)).toBeVisible();
  await expect(recentSection(page).locator(`a[href="/c/${first}"]`)).toHaveCount(0);
  await expect(recentSection(page).locator(`a[href="/c/${latest}"]`)).toHaveCount(0);
  await expect(projectNode(page, pid).locator(`a[href="/c/${latest}"]`)).toBeVisible(); // expanded since it was opened
  await expect(projectNode(page, pid).locator(`a[href="/c/${first}"]`)).toBeVisible();

  // clicking the project opens its most recent conversation with its history, not an empty new chat
  await projectNode(page, pid).getByRole("button", { name: `E2E 專案 ${stamp}`, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/c/${latest}$`));
  await expect(page.getByText(`純文字 專案第二個 ${stamp}`)).toBeVisible();
  await expect(page.locator("header").getByRole("link", { name: /E2E 專案/ })).toBeVisible();
  // continuing stays in that conversation and in the project
  await send(page, `純文字 繼續 ${stamp}`);
  await expect(page.getByText("收到。")).toHaveCount(2);
  expect(page.url()).toContain(`/c/${latest}`);
  const msgs = (await api(page, `/conversations/${latest}/messages`)).messages.filter((m: any) => m.role === "user");
  expect(msgs.length).toBe(2);
  expect((await api(page, `/conversations/${latest}`)).projectId).toBe(pid);

  // a project without conversations opens its page
  await projectNode(page, empty).getByRole("button", { name: `E2E 空專案 ${stamp}`, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/p/${empty}$`));
  await expect(page.getByText("這個專案還沒有對話")).toBeVisible();

  // project page lists the conversations newest first
  await page.goto(`/p/${pid}`);
  const rows = page.getByTestId("project-conversations").locator("a");
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toHaveAttribute("href", `/c/${latest}`);
  await page.getByRole("button", { name: "繼續最近的對話" }).click();
  await expect(page).toHaveURL(new RegExp(`/c/${latest}$`));
});

test("move an old conversation into a project (sidebar menu / project page) and out again", async ({ page }) => {
  const stamp = Date.now();
  const pid = await createProject(page, `E2E 移動 ${stamp}`);
  await page.goto("/");
  const a = await chat(page, `純文字 舊對話甲 ${stamp}`);
  await sidebar(page).getByRole("button", { name: "新對話", exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  const b = await chat(page, `純文字 舊對話乙 ${stamp}`);

  // sidebar menu → 移到專案…
  const rowA = recentSection(page).locator("div.group", { has: page.locator(`a[href="/c/${a}"]`) });
  await rowA.hover();
  await rowA.getByRole("button", { name: "對話選項" }).click();
  await page.getByRole("menuitem", { name: "移到專案…" }).click();
  await page.getByLabel("目標專案").selectOption(pid);
  await page.getByRole("button", { name: "移動", exact: true }).click();
  await expect(recentSection(page).locator(`a[href="/c/${a}"]`)).toHaveCount(0);
  await expect(projectNode(page, pid).locator(`a[href="/c/${a}"]`)).toBeVisible();
  expect((await api(page, `/conversations/${a}`)).projectId).toBe(pid);
  // the open conversation follows the move (breadcrumb)
  await page.goto(`/c/${a}`);
  await expect(page.locator("header").getByRole("link", { name: /E2E 移動/ })).toBeVisible();

  // project page → 加入現有對話 (titles are auto-generated by the mock: give it a findable one)
  await api(page, `/conversations/${b}`, "PATCH", { title: `舊對話乙 ${stamp}` });
  await page.goto(`/p/${pid}`);
  await page.getByRole("button", { name: "加入現有對話" }).click();
  const dlg = page.getByRole("dialog");
  await dlg.getByLabel("篩選對話").fill(`舊對話乙 ${stamp}`);
  await dlg.locator("label", { hasText: `舊對話乙 ${stamp}` }).first().locator("input").check();
  await dlg.getByRole("button", { name: /移入 1 個對話/ }).click();
  await expect(page.getByTestId("project-conversations").locator(`a[href="/c/${b}"]`)).toBeVisible();
  expect((await api(page, `/conversations/${b}`)).projectId).toBe(pid);
  expect((await api(page, "/conversations?projectId=none")).map((c: any) => c.id)).not.toContain(b);

  // 移出專案 (project page row button, and sidebar menu)
  await page.getByRole("button", { name: /把「.*舊對話乙.*」移出專案/ }).click();
  await expect(page.getByTestId("project-conversations").locator(`a[href="/c/${b}"]`)).toHaveCount(0);
  await expect(recentSection(page).locator(`a[href="/c/${b}"]`)).toBeVisible();
  const rowInProject = projectNode(page, pid).locator("div.group", { has: page.locator(`a[href="/c/${a}"]`) });
  await rowInProject.hover();
  await rowInProject.getByRole("button", { name: "對話選項" }).click();
  await page.getByRole("menuitem", { name: "移出專案" }).click();
  await expect(recentSection(page).locator(`a[href="/c/${a}"]`)).toBeVisible();
  expect((await api(page, `/conversations/${a}`)).projectId).toBeNull();
});
