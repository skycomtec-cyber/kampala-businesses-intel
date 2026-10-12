import os
import sys

from playwright.sync_api import sync_playwright

BASE = os.environ.get("KIP_E2E_BASE", "http://127.0.0.1:4399")
errors = []
failures = []

def check(label, condition, detail=""):
    print(f"{'PASS' if condition else 'FAIL'}  {label}" + (f"  [{detail}]" if detail else ""))
    if not condition:
        failures.append(label)

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page()
    def on_console(m):
        if m.type != "error":
            return
        # An optional-session probe (/auth/me) answering 401 is expected for an
        # anonymous visitor and is the same noise operator.html already makes.
        if "401" in m.text and "Unauthorized" in m.text:
            return
        errors.append(f"console.{m.type}: {m.text}")
    page.on("console", on_console)
    page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))

    # --- the list, with no requests yet -----------------------------------
    page.goto(f"{BASE}/requests.html")
    page.wait_for_load_state("networkidle")
    check("list view visible", page.locator("#view-list").is_visible())
    check("empty state shown with no requests", page.locator("#empty").is_visible())
    check("post form hidden on load", page.locator("#view-post").is_hidden())

    # --- post a request ---------------------------------------------------
    page.click("#go-post")
    page.wait_for_timeout(200)
    check("post view visible", page.locator("#view-post").is_visible())

    page.fill("#p-title", "Borehole pump needed for a school")
    page.fill("#p-description", "The old pump stopped in March and the well is still good.")
    # pick the first real options (index 0 is the placeholder)
    page.select_option("#p-category", index=1)
    page.select_option("#p-location", index=1)
    page.select_option("#p-urgency", "high")
    page.fill("#p-budget-min", "500000")
    page.fill("#p-budget-max", "1500000")
    page.fill("#p-item-name", "Hand pump")
    page.fill("#p-item-qty", "2")
    page.click("#p-item-add")
    page.wait_for_timeout(100)
    check("item chips render", page.locator("#p-items li").count() == 1)

    page.click("#p-submit")
    page.wait_for_selector("#post-result:not([hidden])", timeout=5000)
    codes = page.locator("#post-result code").all_inner_texts()
    check("receipt shows reference and token", len(codes) >= 2, str(codes))
    reference = codes[0].strip() if codes else ""
    token = codes[1].strip() if len(codes) > 1 else ""
    check("reference looks like a request reference", reference.startswith("KMP-"), reference)

    # --- follow it back ---------------------------------------------------
    page.click("#post-result a")
    page.wait_for_load_state("networkidle")
    check("detail view visible", page.locator("#view-detail").is_visible())
    check("detail title matches", page.locator("#d-title").inner_text() == "Borehole pump needed for a school")
    check("owner panel visible with token", page.locator("#d-owner").is_visible())
    check("withdraw button offered to owner", page.locator("#d-owner button").count() == 1)
    check("items section shown", page.locator("#d-items-section").is_visible())
    check("offers section hidden with no offers", page.locator("#d-offers-section").is_hidden())
    facts = page.locator("#d-facts").inner_text()
    check("facts carry the reference", reference in facts, facts.replace("\n", " | "))
    check("history shows the post", page.locator("#d-history-section").is_visible())

    # --- back to the list: the request is now there ------------------------
    page.click("#detail-back")
    page.wait_for_load_state("networkidle")
    try:
        page.wait_for_selector("#results .card", timeout=5000)
    except Exception:
        pass
    cards = page.locator("#results .card").count()
    check(
        "list now shows one request",
        cards == 1,
        f"cards={cards} count='{page.locator('#count').inner_text()}' problem='{page.locator('#problem').inner_text()}' empty_hidden={page.locator('#empty').is_hidden()}",
    )

    # --- provider desk: signed out shows the gate --------------------------
    page.goto(f"{BASE}/provider.html")
    page.wait_for_load_state("networkidle")
    check("provider gate visible when signed out", page.locator("#gate").is_visible())
    check("provider desk hidden when signed out", page.locator("#desk").is_hidden())

    browser.close()

print("\nconsole/page errors:", len(errors))
for e in errors:
    print("  ", e)

if failures or errors:
    sys.exit(1)
print("\nALL CHECKS PASSED")