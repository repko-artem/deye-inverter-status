"""
Deye Cloud Status Updater for OSBB Novodarnytske
Автоматично опитує Deye Cloud API, генерує status.json та за потреби піднімає веб-сервер.
"""

import time
import json
import os
import requests
from datetime import datetime, timezone, timedelta

STATION_ID = os.environ.get("DEYE_STATION_ID", "")
TOKEN = os.environ.get("DEYE_TOKEN", "")
DEYE_API_BASE = os.environ.get("DEYE_API_BASE", "https://www.deyecloud.com")
NOMINAL_BATTERY_KWH = float(os.environ.get("BATTERY_CAPACITY_KWH", 65.0))
KYIV_TZ = timezone(timedelta(hours=3))

def fetch_deye_telemetry():
    if not STATION_ID or not TOKEN:
        raise ValueError("DEYE_STATION_ID and DEYE_TOKEN environment variables must be set!")

    headers = {
        "Authorization": f"Bearer {TOKEN}",
        "User-Agent": "Mozilla/5.0"
    }
    
    url_display = f"{DEYE_API_BASE}/maintain-s/station/display/?stationId={STATION_ID}"
    url_device = f"{DEYE_API_BASE}/maintain-s/power/deye/device/{STATION_ID}/device-list?deviceType=INVERTER"

    disp_res = requests.get(url_display, headers=headers, timeout=10)
    disp_res.raise_for_status()
    disp = disp_res.json()

    dev_res = requests.get(url_device, headers=headers, timeout=10)
    dev_res.raise_for_status()
    dev_data = dev_res.json()
    inverter = dev_data.get("data", [{}])[0]
    
    feature_data = {}
    if "featureData" in inverter:
        try:
            feature_data = json.loads(inverter["featureData"])
        except Exception:
            pass

    return disp, feature_data

def update_status_file():
    disp, feat = fetch_deye_telemetry()
    
    soc = disp.get("batterySoc", 75)
    voltage = disp.get("batteryBv", 631.1)
    grid_relay = disp.get("gridRelayStatus", "off")
    is_grid_on = (grid_relay == "on" or disp.get("wirePower", 0) > 100)
    
    use_power_w = disp.get("usePower", 4500)
    battery_power_w = disp.get("batteryPower", 3600)
    
    # Витрачено за день (з інвертора)
    today_discharge_kwh = float(feat.get("Etdy_dcg1", 20.0))
    today_charge_kwh = float(feat.get("Etdy_cg1", 3.0))

    now = datetime.now(KYIV_TZ)
    now_str = now.strftime("%H:%M")

    # Розрахунок залишку часу (до 10% SOC)
    usable_kwh = NOMINAL_BATTERY_KWH * max(0, (soc - 10)) / 100.0
    current_kw = max(1.5, use_power_w / 1000.0)
    hours_left = usable_kwh / current_kw
    
    end_time = now + timedelta(hours=hours_left)
    end_time_str = end_time.strftime("%H:%M")

    payload = {
        "updated_at": now_str,
        "is_grid_on": is_grid_on,
        "outage_start": "18:15",
        "outage_duration_min": int((now - datetime(now.year, now.month, now.day, 18, 15, tzinfo=KYIV_TZ)).total_seconds() / 60) if not is_grid_on else 0,
        "battery_soc": soc,
        "battery_voltage": round(voltage, 1),
        "battery_power_w": battery_power_w,
        "use_power_w": use_power_w,
        "today_discharge_kwh": today_discharge_kwh,
        "today_charge_kwh": today_charge_kwh,
        "nominal_capacity_kwh": NOMINAL_BATTERY_KWH,
        "est_hours_remaining": round(hours_left, 1),
        "est_time_until": end_time_str
    }

    base_dir = os.path.dirname(os.path.abspath(__file__))
    status_file = os.path.join(base_dir, "status.json")
    with open(status_file, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)

    print(f"[{now_str}] Статус оновлено: SOC={soc}%, Навантаження={use_power_w}W, Залишилось: {round(hours_left, 1)} год (~до {end_time_str})")

if __name__ == "__main__":
    print("Запуск сервісу оновлення Deye Cloud...")
    while True:
        try:
            update_status_file()
        except Exception as e:
            print(f"Помилка оновлення: {e}")
        time.sleep(60)  # Опитувати щохвилини
