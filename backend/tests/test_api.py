import sqlite3
import uuid

import pytest
from fastapi.testclient import TestClient

from backend.main import (
    CAMERA_STREAM_LOCK,
    DB_PATH,
    app,
    normalize_product_name,
    resolve_model_path,
)

client = TestClient(app)


@pytest.fixture(autouse=True)
def remove_test_records():
    yield
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute("DELETE FROM staff WHERE name = 'Test Staff' OR employee_code LIKE 'TS-%'")
        conn.execute("DELETE FROM products WHERE name LIKE 'Unique Trial Item%' OR sku LIKE 'SKU-TRIAL-%'")
        conn.execute("DELETE FROM tasks WHERE title LIKE 'Test %'")
        conn.commit()


def test_health_endpoint():
    response = client.get("/health")
    assert response.status_code == 200
    payload = response.json()
    assert payload["success"] is True
    assert payload["data"]["status"] == "ok"


def test_products_endpoint():
    response = client.get("/products")
    assert response.status_code == 200
    payload = response.json()
    assert payload["success"] is True
    assert isinstance(payload["data"], list)
    assert len(payload["data"]) >= 4


def test_staff_endpoints():
    response = client.get("/staff")
    assert response.status_code == 200
    payload = response.json()
    assert payload["success"] is True
    assert isinstance(payload["data"], list)

    employee_code = f"TS-{uuid.uuid4().hex[:8]}"
    post_response = client.post(
        "/staff",
        json={"name": "Test Staff", "employee_code": employee_code, "section": "Grocery", "role": "cashier"},
    )
    assert post_response.status_code == 200
    created = post_response.json()["data"]
    assert created["name"] == "Test Staff"

    checkin_response = client.post(f"/staff/{created['id']}/check-in")
    assert checkin_response.status_code == 200
    assert checkin_response.json()["data"]["checked_in"] is True

    checkout_response = client.post(f"/staff/{created['id']}/check-out")
    assert checkout_response.status_code == 200
    assert checkout_response.json()["data"]["checked_in"] is False


def test_staff_qr_endpoint():
    staff_list = client.get("/staff").json()["data"]
    assert len(staff_list) > 0
    staff_id = staff_list[0]["id"]
    response = client.get(f"/staff/{staff_id}/qr")
    assert response.status_code == 200
    assert response.headers["content-type"] == "image/png"


def test_shelf_detection_endpoint_processes_product_counts():
    payload = {
        "detections": [
            {"name": "Jinthaaa", "count": 2},
            {"name": "Water bottle", "count": 1},
        ]
    }

    response = client.post("/shelf/detect", json=payload)
    assert response.status_code == 200
    body = response.json()
    assert body["success"] is True
    assert body["data"][0]["name"] == "Jinthaaa"
    assert body["data"][0]["count"] == 2
    assert any(item["name"] == "Water bottle" and item["count"] == 1 for item in body["data"])


def test_shelf_detection_endpoint_maps_yolo_labels_to_store_products():
    payload = {"detections": [{"name": "bottle", "count": 1}]}

    response = client.post("/shelf/detect", json=payload)
    assert response.status_code == 200
    body = response.json()
    assert body["success"] is True
    assert any(item["name"] == "Water bottle" for item in body["data"])


def test_image_detection_does_not_use_client_supplied_counts(monkeypatch):
    monkeypatch.setattr("backend.main.detect_products_from_image", lambda image: [])

    response = client.post(
        "/shelf/detect",
        json={
            "image": "data:image/jpeg;base64,ZmFrZQ==",
            "detections": [{"name": "Water bottle", "count": 4}],
        },
    )

    assert response.status_code == 200
    assert response.json()["data"] == []


def test_camera_stream_rejects_a_second_stream_owner():
    assert CAMERA_STREAM_LOCK.acquire(blocking=False)
    try:
        response = client.get("/camera/stream")
    finally:
        CAMERA_STREAM_LOCK.release()

    assert response.status_code == 503


def test_queue_detect_endpoint():
    response = client.post(
        "/queue/detect",
        json={"count": 4},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["success"] is True
    assert body["data"]["people_waiting"] == 4
    assert body["data"]["people_count"] == 4


def test_queue_updates_and_product_task_persistence():
    queue_response = client.post(
        "/queue",
        json={"people_waiting": 7, "support_limit": 6, "average_service_time": 100},
    )
    assert queue_response.status_code == 200
    assert queue_response.json()["data"]["people_waiting"] == 7
    assert queue_response.json()["data"]["support_limit"] == 6

    product_response = client.get("/products")
    product = product_response.json()["data"][0]
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute("UPDATE products SET current_quantity = 4 WHERE id = ?", (product["id"],))
        conn.commit()
    product = client.get("/products").json()["data"][0]
    before_quantity = product["current_quantity"]

    adjust_response = client.post(
        f"/products/{product['id']}/adjust",
        json={"delta": -1},
    )
    assert adjust_response.status_code == 200
    assert adjust_response.json()["data"]["current_quantity"] == before_quantity - 1

    create_response = client.post(
        "/tasks",
        json={
            "type": "MANUAL_TASK",
            "title": "Test queue task",
            "description": "Persisted from API test",
            "priority": 2,
            "status": "ASSIGNED",
        },
    )
    assert create_response.status_code == 200
    task_id = create_response.json()["data"]["id"]

    complete_response = client.post(
        f"/tasks/{task_id}/status",
        json={"status": "COMPLETED"},
    )
    assert complete_response.status_code == 200
    assert complete_response.json()["data"]["status"] == "COMPLETED"


def test_low_stock_alert_is_created_when_stock_drops_below_limit():
    with sqlite3.connect(DB_PATH) as conn:
        rack_id = conn.execute("SELECT id FROM racks WHERE name = 'Rack A'").fetchone()[0]
        load_cell_id = conn.execute("SELECT id FROM load_cells WHERE device_id = 'LC-001'").fetchone()[0]
        unique_name = f"Unique Trial Item {uuid.uuid4().hex[:8]}"
        unique_sku = f"SKU-TRIAL-{uuid.uuid4().hex[:8]}"
        product_id = conn.execute(
            """
            INSERT INTO products(name, sku, category, unit_weight_grams, maximum_quantity, current_quantity, low_stock_limit, rack_id, load_cell_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (unique_name, unique_sku, "Grocery", 300, 6, 6, 2, rack_id, load_cell_id),
        ).lastrowid
        conn.commit()

    before_alerts = client.get("/alerts").json()["data"]
    before_count = len(before_alerts)

    response = client.post(
        f"/products/{product_id}/adjust",
        json={"delta": -5},
    )
    assert response.status_code == 200
    assert response.json()["data"]["current_quantity"] == 1

    after_alerts = client.get("/alerts").json()["data"]
    assert len(after_alerts) > before_count
    assert any(alert["type"] == "LOW_STOCK" and unique_name in alert["title"] for alert in after_alerts)


def test_settings_endpoints():
    response = client.get("/settings")
    assert response.status_code == 200
    payload = response.json()
    assert payload["success"] is True

    update_resp = client.post(
        "/settings",
        json={"low_stock_limit": 3, "queue_support_limit": 6, "average_service_time": 95},
    )
    assert update_resp.status_code == 200
    updated_payload = update_resp.json()["data"]
    assert updated_payload["low_stock_limit"] == 3
    assert updated_payload["queue_support_limit"] == 6


def test_devices_and_analytics_endpoints():
    devices_resp = client.get("/devices")
    assert devices_resp.status_code == 200
    assert isinstance(devices_resp.json()["data"], list)

    dwell_resp = client.get("/analytics/dwell")
    assert dwell_resp.status_code == 200
    assert dwell_resp.json()["data"]["average_dwell_seconds"] > 0


def test_name_normalization_and_model_path():
    assert normalize_product_name("bottle") == "Water bottle"
    assert normalize_product_name("jinthaa") == "Jinthaaa"
    assert normalize_product_name("soap") == "Lifebuoy"
    assert normalize_product_name("dhal") == "Dhal"

    path = resolve_model_path()
    assert path.endswith(".pt")
