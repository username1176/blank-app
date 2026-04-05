"""
AROYA Scraper — logs into app.aroya.io with a real browser, captures every XHR
JSON response, and returns the raw payloads + a flattened readings list.

Usable two ways:
  1) As a module (imported by streamlit_app.py) — call scrape_aroya(user, pw, ...)
  2) Standalone CLI — `python aroya_scraper.py` with AROYA_USER / AROYA_PASS env vars
"""

from __future__ import annotations

import json
import os
import sys
import time
from datetime import datetime
from pathlib import Path

from seleniumwire import webdriver
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait


METRIC_KEYS = {
    "temperature", "temp_c", "temp_f", "temp",
    "humidity", "rh", "humidity_pct",
    "co2", "co2_ppm",
    "vpd", "vpd_kpa",
    "moisture", "water_content", "vwc",
    "ec", "ec_porewater", "ec_bulk",
    "ph", "par", "ppfd",
    "soil_temp", "soil_moisture",
    "value",
}
TIMESTAMP_KEYS = ("timestamp", "time", "recorded_at", "ts", "datetime", "measured_at",
                  "created_at", "createdAt", "recordedAt", "measuredAt", "start", "start_time",
                  "startTime", "date", "dt")
# fields that should never be treated as metrics
SKIP_FIELDS = {"id", "room", "room_id", "roomId", "facility", "facility_id", "facilityId",
               "sensor", "sensor_id", "sensorId", "device_id", "deviceId", "kiosk_id", "kioskId",
               "user_id", "userId", "page", "count", "total", "index", "position"}


def _build_driver(headless=True):
    opts = Options()
    if headless:
        opts.add_argument("--headless=new")
    opts.add_argument("--window-size=1400,900")
    opts.add_argument("--disable-gpu")
    opts.add_argument("--no-sandbox")
    opts.add_argument("--disable-dev-shm-usage")
    # Stealth — avoid trivial headless detection
    opts.add_argument("--disable-blink-features=AutomationControlled")
    opts.add_argument("--user-agent=Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                      "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36")
    opts.add_experimental_option("excludeSwitches", ["enable-automation"])
    opts.add_experimental_option("useAutomationExtension", False)
    # Streamlit Cloud ships chromium at /usr/bin/chromium, driver at /usr/bin/chromedriver
    for path in ("/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"):
        if os.path.exists(path):
            opts.binary_location = path
            break
    driver_path = None
    for path in ("/usr/bin/chromedriver", "/usr/lib/chromium-browser/chromedriver"):
        if os.path.exists(path):
            driver_path = path
            break
    if driver_path:
        driver = webdriver.Chrome(service=Service(driver_path), options=opts)
    else:
        try:
            from webdriver_manager.chrome import ChromeDriverManager
            driver = webdriver.Chrome(service=Service(ChromeDriverManager().install()), options=opts)
        except Exception:
            driver = webdriver.Chrome(options=opts)
    # Hide webdriver flag
    try:
        driver.execute_cdp_cmd("Page.addScriptToEvaluateOnNewDocument", {
            "source": "Object.defineProperty(navigator, 'webdriver', {get: () => undefined})"
        })
    except Exception:
        pass
    return driver


def _find_field(driver, selector_or_name):
    candidates = [
        (By.CSS_SELECTOR, selector_or_name),
        (By.NAME, selector_or_name),
        (By.ID, selector_or_name),
        (By.CSS_SELECTOR, f"input[name='{selector_or_name}']"),
        (By.CSS_SELECTOR, f"input[type='{selector_or_name}']"),
    ]
    for by, sel in candidates:
        try:
            el = driver.find_element(by, sel)
            if el:
                return el
        except Exception:
            continue
    return None


def _snap(driver):
    """Return base64 PNG screenshot + URL + title for debugging."""
    try:
        return {
            "url": driver.current_url,
            "title": driver.title or "",
            "png_b64": driver.get_screenshot_as_base64(),
            "html_preview": driver.page_source[:3000],
        }
    except Exception as e:
        return {"url": "?", "title": "?", "png_b64": "", "html_preview": f"snapshot failed: {e}"}


def _login(driver, user, password, login_url, user_field="email", pass_field="password",
           submit_btn="button[type=submit]", login_timeout=90):
    driver.get(login_url)
    WebDriverWait(driver, 30).until(lambda d: d.execute_script("return document.readyState") == "complete")
    # let JS-rendered forms mount
    time.sleep(3)

    user_el = _find_field(driver, user_field)
    pass_el = _find_field(driver, pass_field)
    if not user_el or not pass_el:
        snap = _snap(driver)
        raise RuntimeError(
            f"LOGIN_FIELDS_NOT_FOUND | url={snap['url']} | title={snap['title']}",
        ) from None

    # React-aware fill: set value via native setter and dispatch input+change+blur events
    # so MUI's controlled inputs register the value and enable the submit button.
    react_fill = """
        const el = arguments[0]; const val = arguments[1];
        const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
        setter.call(el, val);
        el.dispatchEvent(new Event('input',  { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('blur',   { bubbles: true }));
    """
    user_el.clear()
    driver.execute_script(react_fill, user_el, user)
    # also send_keys as belt-and-suspenders for any keyboard-event listeners
    user_el.send_keys(" "); user_el.send_keys("\b")
    pass_el.clear()
    driver.execute_script(react_fill, pass_el, password)
    pass_el.send_keys(" "); pass_el.send_keys("\b")
    time.sleep(1)  # let React re-render & validate

    pre_url = driver.current_url

    # Try many ways to submit
    submitted = False
    selectors_tried = []
    button_candidates = [
        submit_btn,
        "button[type='submit']",
        "form button",
        "button.MuiButton-root",
        "button.MuiLoadingButton-root",
    ]
    for sel in button_candidates:
        try:
            btns = driver.find_elements(By.CSS_SELECTOR, sel)
            for b in btns:
                if b.is_displayed() and b.is_enabled():
                    try:
                        b.click()
                        submitted = True
                        selectors_tried.append(f"click:{sel}")
                        break
                    except Exception:
                        continue
            if submitted:
                break
        except Exception:
            continue

    # XPath fallback: any button with login-ish text
    if not submitted:
        for xpath in (
            "//button[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'sign in')]",
            "//button[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'log in')]",
            "//button[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'login')]",
        ):
            try:
                b = driver.find_element(By.XPATH, xpath)
                b.click()
                submitted = True
                selectors_tried.append(f"xpath:{xpath[:40]}")
                break
            except Exception:
                continue

    # Ultimate fallback: press Enter in password field
    if not submitted:
        try:
            from selenium.webdriver.common.keys import Keys
            pass_el.send_keys(Keys.RETURN)
            submitted = True
            selectors_tried.append("enter-key")
        except Exception:
            pass

    if not submitted:
        snap = _snap(driver)
        err = RuntimeError(f"SUBMIT_BUTTON_NOT_FOUND | url={snap['url']}")
        err.snapshot = snap
        raise err

    # Wait for either URL change OR login form disappearing OR error message appearing
    def _logged_in(d):
        try:
            if "login" not in d.current_url.lower():
                return True
            # form no longer present?
            if not d.find_elements(By.CSS_SELECTOR, "input[type='password']"):
                return True
        except Exception:
            pass
        return False

    try:
        WebDriverWait(driver, login_timeout).until(_logged_in)
    except Exception:
        snap = _snap(driver)
        # look for any visible error text on page
        err_text = ""
        try:
            for el in driver.find_elements(By.CSS_SELECTOR, ".Mui-error, [role='alert'], .error, .errorMessage"):
                if el.is_displayed() and el.text.strip():
                    err_text += el.text.strip() + " | "
        except Exception:
            pass
        err = RuntimeError(
            f"LOGIN_TIMEOUT_{login_timeout}s | "
            f"pre_url={pre_url} | post_url={snap['url']} | "
            f"submit_via={','.join(selectors_tried)} | "
            f"page_errors={err_text or 'none'}"
        )
        err.snapshot = snap
        raise err
    return driver.current_url


def _capture_page(driver, url, wait_secs=20, idle_secs=5, max_wait=120):
    """Navigate to url, then wait until network traffic goes idle (no new requests for idle_secs
    seconds) OR max_wait is reached. Captures all JSON responses seen during the load."""
    del driver.requests
    driver.get(url)

    # Network-idle wait: poll request count and stop when it stops growing.
    start = time.time()
    last_count = 0
    last_change = time.time()
    min_wait_until = start + wait_secs  # always wait at least this long
    while True:
        now = time.time()
        count = len(driver.requests)
        if count != last_count:
            last_count = count
            last_change = now
        elapsed_idle = now - last_change
        total_elapsed = now - start
        if total_elapsed >= max_wait:
            break
        if now >= min_wait_until and elapsed_idle >= idle_secs:
            break
        time.sleep(0.5)

    captures = []
    for req in driver.requests:
        if not req.response:
            continue
        ctype = req.response.headers.get("content-type", "") or ""
        if "json" not in ctype.lower():
            continue
        try:
            body = req.response.body.decode("utf-8", errors="replace")
            payload = json.loads(body)
        except Exception:
            continue
        captures.append({
            "url": req.url,
            "method": req.method,
            "status": req.response.status_code,
            "payload": payload,
        })
    return captures


def _is_timestamp_like(v):
    if not isinstance(v, str) or len(v) < 8:
        return False
    # ISO 8601-ish: YYYY-MM-DD... or contains T and colon
    return (v[:4].isdigit() and "-" in v[:10]) or ("T" in v and ":" in v)


def _find_timestamp(d):
    # exact key match first
    for k in TIMESTAMP_KEYS:
        if k in d and isinstance(d[k], str) and _is_timestamp_like(d[k]):
            return d[k]
    # fuzzy: any key containing 'time'/'date'/'at' with timestamp-like value
    for k, v in d.items():
        kl = k.lower()
        if ("time" in kl or "date" in kl or kl.endswith("at")) and _is_timestamp_like(v):
            return v
    return None


def _context_fields(d):
    ctx = {}
    for key, attr in [
        (("facility", "facility_name", "facilityName"), "facility"),
        (("room", "room_name", "roomName", "zone", "zone_name"), "room"),
        (("sensor", "sensor_name", "sensorName", "name"), "sensor_name"),
        (("sensor_id", "sensorId", "device_id", "deviceId", "kiosk_id", "kioskId", "id"), "sensor_id"),
    ]:
        for k in key:
            if k in d and d[k] not in (None, "", [], {}):
                v = d[k]
                if isinstance(v, dict):
                    v = v.get("name") or v.get("id") or str(v)
                ctx[attr] = str(v)
                break
    return ctx


def flatten_readings(all_captures):
    """Walk every JSON payload recursively; for any dict with a timestamp, emit one row
    per numeric field (excluding obvious ID/pagination fields)."""
    rows = []

    def walk(node, url, ctx):
        if isinstance(node, list):
            for item in node:
                walk(item, url, ctx)
            return
        if not isinstance(node, dict):
            return

        # refine context from this node
        new_ctx = dict(ctx)
        new_ctx.update(_context_fields(node))

        ts = _find_timestamp(node)
        if ts is not None:
            for k, v in node.items():
                if k in SKIP_FIELDS or k in TIMESTAMP_KEYS:
                    continue
                if isinstance(v, bool) or v is None or isinstance(v, (list, dict)):
                    continue
                if isinstance(v, (int, float)):
                    rows.append({
                        "timestamp": ts,
                        "facility": new_ctx.get("facility", ""),
                        "room": new_ctx.get("room", ""),
                        "sensor_id": new_ctx.get("sensor_id", ""),
                        "sensor_name": new_ctx.get("sensor_name", ""),
                        "metric": k,
                        "value": v,
                        "unit": node.get("unit", ""),
                        "source_url": url,
                    })
                elif isinstance(v, str):
                    # try to coerce numeric strings
                    try:
                        vf = float(v)
                        rows.append({
                            "timestamp": ts,
                            "facility": new_ctx.get("facility", ""),
                            "room": new_ctx.get("room", ""),
                            "sensor_id": new_ctx.get("sensor_id", ""),
                            "sensor_name": new_ctx.get("sensor_name", ""),
                            "metric": k,
                            "value": vf,
                            "unit": node.get("unit", ""),
                            "source_url": url,
                        })
                    except ValueError:
                        pass

        # recurse into children even if this node had a timestamp — nested time series are common
        for v in node.values():
            if isinstance(v, (list, dict)):
                walk(v, url, new_ctx)

    for cap in all_captures:
        # infer facility/room from URL query params when possible
        url_ctx = {}
        try:
            from urllib.parse import urlparse, parse_qs
            qs = parse_qs(urlparse(cap["url"]).query)
            for k in ("room", "facility", "sensor", "kiosk"):
                if k in qs and qs[k]:
                    url_ctx[k] = qs[k][0]
            # path-based room/facility (e.g. /f/3766/.. or /kiosk/17627/..)
            parts = urlparse(cap["url"]).path.strip("/").split("/")
            for i, p in enumerate(parts):
                if p in ("f", "facility", "facilities") and i + 1 < len(parts):
                    url_ctx.setdefault("facility", parts[i + 1])
                if p in ("room", "rooms") and i + 1 < len(parts):
                    url_ctx.setdefault("room", parts[i + 1])
                if p in ("kiosk", "kiosks") and i + 1 < len(parts):
                    url_ctx.setdefault("sensor_id", parts[i + 1])
        except Exception:
            pass
        ctx = {"facility": url_ctx.get("facility", ""), "room": url_ctx.get("room", ""),
               "sensor_id": url_ctx.get("sensor_id", "")}
        walk(cap["payload"], cap["url"], ctx)
    return rows


def scrape_aroya(
    user,
    password,
    login_url="https://app.aroya.io/login",
    target_urls=("https://app.aroya.io/",),
    headless=True,
    wait_secs=20,
    login_timeout=90,
    user_field="email",
    pass_field="password",
    submit_btn="button[type=submit]",
):
    """Run an end-to-end scrape. Returns dict with raw captures, flattened rows, endpoints, landing_url.
    On login failure, returned dict includes `error` and `snapshot` (screenshot + HTML preview)."""
    driver = _build_driver(headless=headless)
    try:
        try:
            landing = _login(driver, user, password, login_url, login_timeout=login_timeout,
                             user_field=user_field, pass_field=pass_field, submit_btn=submit_btn)
        except RuntimeError as e:
            snap = getattr(e, "snapshot", None) or _snap(driver)
            return {"error": str(e), "snapshot": snap, "landing_url": None,
                    "captures": [], "rows": [], "endpoints": []}

        post_login_snap = _snap(driver)
        all_captures = []
        for url in target_urls:
            all_captures.extend(_capture_page(driver, url, wait_secs=wait_secs))
        rows = flatten_readings(all_captures)
        endpoints = sorted({c["url"] for c in all_captures})
        return {
            "landing_url": landing,
            "captures": all_captures,
            "rows": rows,
            "endpoints": endpoints,
            "snapshot": post_login_snap,
        }
    finally:
        driver.quit()


# ─── CLI ─────────────────────────────────────────────────────────────────────
def _main():
    user = os.environ.get("AROYA_USER", "")
    pw = os.environ.get("AROYA_PASS", "")
    if not user or not pw:
        print("Set AROYA_USER and AROYA_PASS env vars.")
        sys.exit(1)

    targets = [u.strip() for u in os.environ.get("AROYA_TARGET_URLS", "https://app.aroya.io/").split(",") if u.strip()]
    out_dir = Path(os.environ.get("AROYA_OUTPUT_DIR", "./aroya_captures"))
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")

    result = scrape_aroya(
        user, pw,
        login_url=os.environ.get("AROYA_LOGIN_URL", "https://app.aroya.io/login"),
        target_urls=targets,
        headless=os.environ.get("AROYA_HEADLESS", "0") == "1",
        wait_secs=int(os.environ.get("AROYA_WAIT_SECS", "20")),
    )

    (out_dir / f"aroya_raw_{stamp}.json").write_text(json.dumps(result["captures"], indent=2, default=str))
    (out_dir / f"aroya_endpoints_{stamp}.txt").write_text("\n".join(result["endpoints"]))
    if result["rows"]:
        import csv
        with (out_dir / f"aroya_readings_{stamp}.csv").open("w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=list(result["rows"][0].keys()))
            w.writeheader(); w.writerows(result["rows"])
    print(f"✓ {len(result['rows'])} readings · {len(result['endpoints'])} endpoints → {out_dir}")


if __name__ == "__main__":
    _main()
