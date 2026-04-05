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
TIMESTAMP_KEYS = ("timestamp", "time", "recorded_at", "ts", "datetime", "measured_at")


def _build_driver(headless=True):
    opts = Options()
    if headless:
        opts.add_argument("--headless=new")
    opts.add_argument("--window-size=1400,900")
    opts.add_argument("--disable-gpu")
    opts.add_argument("--no-sandbox")
    opts.add_argument("--disable-dev-shm-usage")
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
        return webdriver.Chrome(service=Service(driver_path), options=opts)
    # local dev fallback
    try:
        from webdriver_manager.chrome import ChromeDriverManager
        return webdriver.Chrome(service=Service(ChromeDriverManager().install()), options=opts)
    except Exception:
        return webdriver.Chrome(options=opts)


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


def _login(driver, user, password, login_url, user_field="email", pass_field="password",
           submit_btn="button[type=submit]"):
    driver.get(login_url)
    WebDriverWait(driver, 20).until(lambda d: d.execute_script("return document.readyState") == "complete")

    user_el = _find_field(driver, user_field)
    pass_el = _find_field(driver, pass_field)
    if not user_el or not pass_el:
        raise RuntimeError(
            "Could not locate login fields. Inspect the login page and adjust "
            "user_field/pass_field. Page title: " + (driver.title or "?")
        )

    user_el.clear(); user_el.send_keys(user)
    pass_el.clear(); pass_el.send_keys(password)

    try:
        driver.find_element(By.CSS_SELECTOR, submit_btn).click()
    except Exception:
        pass_el.submit()

    WebDriverWait(driver, 25).until(lambda d: "login" not in d.current_url.lower())
    return driver.current_url


def _capture_page(driver, url, wait_secs=20):
    del driver.requests
    driver.get(url)
    time.sleep(wait_secs)

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


def flatten_readings(all_captures):
    rows = []
    for cap in all_captures:
        payload = cap["payload"]
        candidates = []
        if isinstance(payload, list):
            candidates.append(payload)
        elif isinstance(payload, dict):
            for v in payload.values():
                if isinstance(v, list):
                    candidates.append(v)
        for items in candidates:
            for item in items:
                if not isinstance(item, dict):
                    continue
                ts = next((item[k] for k in TIMESTAMP_KEYS if k in item), None)
                if ts is None:
                    continue
                for metric in METRIC_KEYS & set(item.keys()):
                    val = item[metric]
                    if val is None or isinstance(val, (list, dict)):
                        continue
                    rows.append({
                        "timestamp": ts,
                        "facility": item.get("facility") or item.get("facility_name") or "",
                        "room": item.get("room") or item.get("room_name") or item.get("zone") or "",
                        "sensor_id": str(item.get("sensor_id") or item.get("id") or item.get("device_id") or ""),
                        "sensor_name": item.get("sensor_name") or item.get("name") or item.get("type") or "",
                        "metric": metric,
                        "value": val,
                        "unit": item.get("unit", ""),
                        "source_url": cap["url"],
                    })
    return rows


def scrape_aroya(
    user,
    password,
    login_url="https://app.aroya.io/login",
    target_urls=("https://app.aroya.io/",),
    headless=True,
    wait_secs=20,
    user_field="email",
    pass_field="password",
    submit_btn="button[type=submit]",
):
    """Run an end-to-end scrape. Returns dict with raw captures, flattened rows, endpoints, landing_url."""
    driver = _build_driver(headless=headless)
    try:
        landing = _login(driver, user, password, login_url,
                         user_field=user_field, pass_field=pass_field, submit_btn=submit_btn)
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
