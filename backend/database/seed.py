from __future__ import annotations

import sqlite3
from pathlib import Path


def seed_default_data(conn: sqlite3.Connection) -> None:
    """Insert the default rack, load cell, product, and staff records used by the demo."""
    rack_rows = [
        ("Rack A", "Aisle A", "ACTIVE"),
        ("Rack B", "Aisle B", "ACTIVE"),
    ]

    existing_racks = conn.execute("SELECT COUNT(*) FROM racks").fetchone()[0]
    if existing_racks == 0:
        conn.executemany(
            "INSERT INTO racks(name, location, status) VALUES (?, ?, ?)",
            rack_rows,
        )

    rack_a_id = conn.execute("SELECT id FROM racks WHERE name = 'Rack A'").fetchone()[0]
    rack_b_id = conn.execute("SELECT id FROM racks WHERE name = 'Rack B'").fetchone()[0]

    load_cell_rows = [
        ("LC-001", rack_a_id, 1, 1.0, 0.0, 0.0, 0.0, 0.0, None, "ONLINE"),
        ("LC-002", rack_b_id, 2, 1.0, 0.0, 0.0, 0.0, 0.0, None, "ONLINE"),
    ]

    existing_load_cells = conn.execute("SELECT COUNT(*) FROM load_cells").fetchone()[0]
    if existing_load_cells == 0:
        conn.executemany(
            """
            INSERT INTO load_cells(
                device_id, rack_id, cell_number, calibration_factor, tare_weight,
                current_weight, previous_weight, stable_weight, last_reading, status
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            load_cell_rows,
        )

    load_cell_1_id = conn.execute("SELECT id FROM load_cells WHERE device_id = 'LC-001'").fetchone()[0]
    load_cell_2_id = conn.execute("SELECT id FROM load_cells WHERE device_id = 'LC-002'").fetchone()[0]

    product_rows = [
        ("Jinthaaa", "SKU-JIN-01", "Grocery", 218, 4, 4, 2, rack_a_id, load_cell_1_id),
        ("Dhal", "SKU-DHAL-01", "Grocery", 250, 4, 4, 2, rack_a_id, load_cell_1_id),
        ("Water bottle", "SKU-WTR-01", "Drinks", 512, 4, 4, 2, rack_b_id, load_cell_2_id),
        ("Lifebuoy", "SKU-LIFE-01", "Personal care", 118, 4, 4, 2, rack_b_id, load_cell_2_id),
    ]

    existing_products = conn.execute("SELECT COUNT(*) FROM products").fetchone()[0]
    if existing_products == 0:
        conn.executemany(
            """
            INSERT INTO products(
                name, sku, category, unit_weight_grams, maximum_quantity, current_quantity,
                low_stock_limit, rack_id, load_cell_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            product_rows,
        )

    existing_staff = conn.execute("SELECT COUNT(*) FROM staff").fetchone()[0]
    if existing_staff == 0:
        conn.executemany(
            """
            INSERT INTO staff(name, employee_code, section, role, qr_token, checked_in, last_check_in, last_check_out)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            [
                ("Ananya", "EMP-001", "Grocery", "cashier", "SMARTMART-001", 1, "2026-09-27T08:00:00", None),
                ("Kavin", "EMP-002", "Checkout", "cashier", "SMARTMART-002", 1, "2026-09-27T08:30:00", None),
                ("Meera", "EMP-003", "Personal care", "stocker", "SMARTMART-003", 0, None, None),
            ],
        )

    queue_exists = conn.execute("SELECT COUNT(*) FROM queue_status").fetchone()[0]
    if queue_exists == 0:
        conn.execute(
            "INSERT INTO queue_status(people_waiting, average_service_time, estimated_wait, support_limit) VALUES (?, ?, ?, ?)",
            (5, 90, 7, 5),
        )

    settings_exists = conn.execute("SELECT COUNT(*) FROM settings").fetchone()[0]
    if settings_exists == 0:
        conn.execute(
            """
            INSERT INTO settings(
                low_stock_limit, queue_support_limit, average_service_time,
                weight_tolerance_percent, event_cooldown_seconds, device_timeout_seconds,
                ai_confidence_threshold, event_correlation_window_ms
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (2, 5, 90, 10, 5, 30, 0.8, 3000),
        )

    device_rows = [
        ("ESP32-RACK-A", "ESP32", rack_a_id, "ONLINE", "2026-09-27T08:00:00", "v1.0.0", "REAL"),
        ("ESP32-RACK-B", "ESP32", rack_b_id, "ONLINE", "2026-09-27T08:00:00", "v1.0.0", "REAL"),
        ("CAMERA-SHELF", "CAMERA", rack_a_id, "OFFLINE", None, "v1.0.0", "REAL"),
        ("CAMERA-QUEUE", "CAMERA", rack_b_id, "OFFLINE", None, "v1.0.0", "REAL"),
    ]
    if conn.execute("SELECT COUNT(*) FROM devices").fetchone()[0] == 0:
        conn.executemany(
            "INSERT INTO devices(device_id, device_type, rack_id, status, last_seen, firmware_version, source) VALUES (?, ?, ?, ?, ?, ?, ?)",
            device_rows,
        )

    if conn.execute("SELECT COUNT(*) FROM alerts").fetchone()[0] == 0:
        conn.execute(
            "INSERT INTO alerts(type, severity, title, message) VALUES (?, ?, ?, ?)",
            ("LOW_STOCK", "MEDIUM", "Jinthaaa low stock", "Stock is nearing the refill threshold."),
        )

    conn.commit()
