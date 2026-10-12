import os
import sys

from playwright.sync_api import sync_playwright

BASE = os.environ.get("KIP_E2E_BASE", "http://127.0.0.1:4399")
EMAIL = os.environ.get("KIP_DEMO_ADMIN_EMAIL", "demo@example.com")
PASSWORD = os.environ.get("KIP_DEMO_ADMIN_PASSWORD", "demo-password-123")
errors = []
failures = []

def check(label, condition, detail=""):
    print(f"{'PASS' if condition else 'FAIL'}  {label}" + (f"  [{detail}]" if detail else ""))
    if not condition:
        failures.append(label)

def monitor(page, errors):
    def on_console(m):
        if m.type != "error":
            return
        if "auth/me" in m.location.get("url", "") and m.text and "401" in m.text:
            return
        errors.append(f"console: {m.text} @ {m.location.get('url', '?')}")
    page.on("console", on_console)
    page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))

def post_request(browser, title, cat, loc, errors):
    """Post from a fresh anonymous session, like a brand-new visitor."""
    ctx = browser.new_context()
    page = ctx.new_page()
    monitor(page, errors)
    page.goto(f"{BASE}/requests.html")
    page.wait_for_load_state("networkidle")
    page.click("#go-post")
    page.wait_for_selector("#view-post")
    page.fill("#p-title", title)
    page.select_option("#p-category", cat)
    page.select_option("#p-location", loc)
    page.select_option("#p-urgency", "high")
    page.fill("#p-description", "Needs a working unit as soon as possible.")
    page.click("#p-submit")
    page.wait_for_selector("#post-result:not([hidden])", timeout=8000)
    codes = page.locator("#post-result code").all_inner_texts()
    result = (codes[0].strip(), codes[1].strip() if len(codes) > 1 else "")
    ctx.close()
    return result

def offer_like(page, ref, message):
    """Offers on the `.work` row whose reference matches, wherever it sits."""
    row = page.locator("#matches .work", has_text=ref)
    row.locator(".offer-form textarea").fill(message)
    row.locator(".offer-form button[type=submit]").click()
    page.wait_for_function(
        "Array.from(document.querySelectorAll('.mine')).some(r => "
        f"r.innerText.includes('{ref}') && r.innerText.includes('Offered'))",
        timeout=8000,
    )

def confirm_sheet(page):
    page.wait_for_selector("dialog.sheet", state="visible", timeout=5000)
    page.locator("dialog.sheet button[value=confirm]").click()

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)

    # ---------- provider signs in first --------------------------------------
    desk_ctx = browser.new_context()
    desk = desk_ctx.new_page()
    monitor(desk, errors)
    desk.goto(f"{BASE}/provider.html")
    desk.fill("#email", EMAIL)
    desk.fill("#password", PASSWORD)
    desk.click("#sign-in")
    desk.wait_for_selector("#desk:not([hidden])", timeout=8000)
    desk.wait_for_function("document.querySelectorAll('#business option').length > 0", timeout=8000)
    check("business picker populated", desk.locator("#business option").count() >= 20,
          f"options={desk.locator('#business option').count()}")

    all_businesses = desk_ctx.request.get(f"{BASE}/api/v1/admin/businesses?limit=100&sort=name").json()["data"]
    A = all_businesses[0]
    B = all_businesses[1]
    assert B["id"] != A["id"], "need a second business to put a competing offer on"

    # The website column starts empty on every demonstration listing.
    check("website link hidden without one", desk.locator("#business-site").is_hidden())
    assert desk_ctx.request.patch(f"{BASE}/api/v1/admin/businesses/{A['id']}",
        headers={"content-type": "application/json"},
        data='{"website":"https://example.com/demo-shop"}').ok
    # Make B's category and place identical to A's so a single request matches
    # both, giving the requester two offers to choose between.
    assert desk_ctx.request.patch(f"{BASE}/api/v1/admin/businesses/{B['id']}",
        headers={"content-type": "application/json"},
        data='{"categoryId":"%s","locationId":"%s"}' % (A["categoryId"], A["primaryLocationId"])).ok
    cat, loc = A["categoryId"], A["primaryLocationId"]

    desk.reload()
    desk.wait_for_selector("#desk:not([hidden])", timeout=8000)
    desk.wait_for_function("document.querySelectorAll('#business option').length > 0", timeout=8000)
    site = desk.locator("#business-site")
    check("website link shown once set", site.is_visible())
    check("website link opens the business site", "example.com/demo-shop" in site.get_attribute("href"))

    # ---------- three anonymous visitors each post a request -----------------
    R1 = post_request(browser, "Refurbished unit wanted", cat, loc, errors)
    R2 = post_request(browser, "Second refurbished unit wanted", cat, loc, errors)
    R3 = post_request(browser, "Third refurbished unit wanted", cat, loc, errors)
    for name, (ref, token) in [("R1", R1), ("R2", R2), ("R3", R3)]:
        check(f"{name} gets a reference", ref.startswith("KMP-"), ref)
        check(f"{name} gets an access token", len(token) >= 20)

    desk.click("#refresh")
    desk.wait_for_function(
        f"document.getElementById('matches').innerText.includes('{R1[0]}')", timeout=8000)
    check("matching list shows R1", True)

    # ---------- two businesses answer the same request -------------------------
    offer_like(desk, R1[0], "We are A and can supply a refurbished unit within two days.")
    desk.wait_for_function(
        f"!document.getElementById('matches').innerText.includes('{R1[0]}')", timeout=8000)
    check("R1 left A's matcher once answered", True)
    desk.wait_for_function(
        f"document.getElementById('matches').innerText.includes('{R2[0]}')", timeout=8000)
    check("R2 and R3 are still open to A",
          R2[0] in desk.locator("#matches").inner_text() and R3[0] in desk.locator("#matches").inner_text())

    desk.select_option("#business", value=B["id"])
    desk.wait_for_selector(".work", timeout=8000)
    offer_like(desk, R1[0], "We are B and can supply a refurbished unit within three days.")
    check("B has answered R1 too", R1[0] in desk.locator("#offers").inner_text())

    # ---------- the requester reads both offers, then a stranger sees nothing --
    owner_ctx = browser.new_context()
    owner_ctx.add_init_script(
        "localStorage.setItem('kip-request-tokens', JSON.stringify("
        + __import__("json").dumps({R1[0]: R1[1], R2[0]: R2[1], R3[0]: R3[1]})
        + "))"
    )
    owner = owner_ctx.new_page()
    monitor(owner, errors)
    owner.goto(f"{BASE}/requests.html?r={R1[0]}")
    owner.wait_for_load_state("networkidle")
    owner.wait_for_function("document.querySelectorAll('#d-offers .offer-row').length === 2", timeout=8000)
    check("owner sees both offer messages",
          "within two days" in owner.locator("#d-offers").inner_text()
          and "within three days" in owner.locator("#d-offers").inner_text())
    check("owner gets two accept buttons", owner.locator("#d-offers button", has_text="Accept this offer").count() == 2)

    stranger = browser.new_context()
    s_page = stranger.new_page()
    monitor(s_page, errors)
    s_page.goto(f"{BASE}/requests.html?r={R1[0]}")
    s_page.wait_for_load_state("networkidle")
    public_txt = s_page.locator("#d-offers").inner_text()
    check("public view lists both offers", "Offered" in public_txt)
    check("public view hides both messages",
          "within two days" not in public_txt and "within three days" not in public_txt)
    check("public view hints messages belong to the requester",
          "requester only" in s_page.locator("#d-token-hint").inner_text())

    # ---------- accepting one offer declines the other ------------------------
    a_row = owner.locator("#d-offers .offer-row", has_text=A["name"])
    a_row.locator("button", has_text="Accept this offer").click()
    confirm_sheet(owner)
    owner.wait_for_function("document.getElementById('d-facts').innerText.includes('In progress')", timeout=8000)
    offers_txt = owner.locator("#d-offers").inner_text()
    check("accepting A declines B", "Accepted" in offers_txt and "Declined" in offers_txt)
    check("no offers are still open to accept", owner.locator("#d-offers button").count() == 0)

    # ---------- provider withdraws an offer ----------------------------------
    desk.select_option("#business", value=A["id"])
    desk.wait_for_selector(".work", timeout=8000)
    offer_like(desk, R2[0], "A can supply the second unit too.")
    r2_row = desk.locator(".mine", has_text=R2[0])
    r2_row.locator("button", has_text="Withdraw offer").click()
    confirm_sheet(desk)
    desk.wait_for_function(
        "Array.from(document.querySelectorAll('.mine')).some(r => "
        f"r.innerText.includes('{R2[0]}') && r.innerText.includes('Withdrawn'))",
        timeout=8000,
    )
    check("offer shows as withdrawn", True)
    # Once a request has been answered it is never offered again, so the matcher
    # still excludes it even though the offer is now withdrawn.
    check("answered request stays out of the matcher after withdrawing",
          R2[0] not in desk.locator("#matches").inner_text())

    # ---------- the requester withdraws a request -----------------------------
    # A never answered R3, so it still sits in A's matcher right now.
    desk.wait_for_function(
        f"document.getElementById('matches').innerText.includes('{R3[0]}')", timeout=8000)
    check("R3 is still open to A before the requester acts", True)

    owner.goto(f"{BASE}/requests.html?r={R3[0]}")
    owner.wait_for_load_state("networkidle")
    owner.wait_for_selector("#d-owner:not([hidden])", timeout=8000)
    owner.locator("#d-owner button", has_text="Withdraw this request").click()
    confirm_sheet(owner)
    owner.wait_for_function("document.getElementById('d-facts').innerText.includes('Cancelled')", timeout=8000)
    check("withdrawing a request closes it", True)

    desk.click("#refresh")
    desk.wait_for_function(
        f"!document.getElementById('matches').innerText.includes('{R3[0]}')", timeout=8000)
    check("withdrawing a request removes it from the matcher", True)
    check("R2 stays out of the matcher too", R2[0] not in desk.locator("#matches").inner_text())

    desk_ctx.close()
    owner_ctx.close()
    stranger.close()
    browser.close()

if errors:
    print("\nconsole/page errors:", len(errors))
    for e in errors:
        print("  ", e)

if failures or errors:
    sys.exit(1)
print("\n\nALL CHECKS PASSED")