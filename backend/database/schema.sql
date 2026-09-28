PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS racks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    location TEXT,
    status TEXT NOT NULL DEFAULT 'ACTIVE'
);

CREATE TABLE IF NOT EXISTS load_cells (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT NOT NULL UNIQUE,
    rack_id INTEGER NOT NULL,
    cell_number INTEGER NOT NULL,
    calibration_factor REAL NOT NULL DEFAULT 1.0,
    tare_weight REAL NOT NULL DEFAULT 0,
    current_weight REAL NOT NULL DEFAULT 0,
    previous_weight REAL NOT NULL DEFAULT 0,
    stable_weight REAL NOT NULL DEFAULT 0,
    last_reading TEXT,
    status TEXT NOT NULL DEFAULT 'ONLINE',
    FOREIGN KEY (rack_id) REFERENCES racks(id)
);

CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    sku TEXT NOT NULL UNIQUE,
    category TEXT NOT NULL,
    unit_weight_grams INTEGER NOT NULL,
    maximum_quantity INTEGER NOT NULL,
    current_quantity INTEGER NOT NULL,
    low_stock_limit INTEGER NOT NULL,
    rack_id INTEGER NOT NULL,
    load_cell_id INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (rack_id) REFERENCES racks(id),
    FOREIGN KEY (load_cell_id) REFERENCES load_cells(id)
);

CREATE TABLE IF NOT EXISTS staff (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    employee_code TEXT NOT NULL UNIQUE,
    section TEXT NOT NULL,
    role TEXT NOT NULL,
    qr_token TEXT NOT NULL UNIQUE,
    checked_in INTEGER NOT NULL DEFAULT 0,
    last_check_in TEXT,
    last_check_out TEXT
);

CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    staff_id INTEGER,
    product_id INTEGER,
    priority INTEGER NOT NULL DEFAULT 2,
    status TEXT NOT NULL DEFAULT 'UNASSIGNED',
    verification_result TEXT DEFAULT 'PENDING',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT,
    FOREIGN KEY (staff_id) REFERENCES staff(id),
    FOREIGN KEY (product_id) REFERENCES products(id)
);

CREATE TABLE IF NOT EXISTS queue_status (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    people_waiting INTEGER NOT NULL DEFAULT 0,
    average_service_time INTEGER NOT NULL DEFAULT 90,
    estimated_wait INTEGER NOT NULL DEFAULT 0,
    support_limit INTEGER NOT NULL DEFAULT 5,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    low_stock_limit INTEGER NOT NULL DEFAULT 2,
    queue_support_limit INTEGER NOT NULL DEFAULT 5,
    average_service_time INTEGER NOT NULL DEFAULT 90,
    weight_tolerance_percent INTEGER NOT NULL DEFAULT 10,
    event_cooldown_seconds INTEGER NOT NULL DEFAULT 5,
    device_timeout_seconds INTEGER NOT NULL DEFAULT 30,
    ai_confidence_threshold REAL NOT NULL DEFAULT 0.8,
    event_correlation_window_ms INTEGER NOT NULL DEFAULT 3000,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS devices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT NOT NULL UNIQUE,
    device_type TEXT NOT NULL,
    rack_id INTEGER,
    status TEXT NOT NULL DEFAULT 'ONLINE',
    last_seen TEXT,
    firmware_version TEXT,
    source TEXT NOT NULL DEFAULT 'REAL'
);

CREATE TABLE IF NOT EXISTS alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    severity TEXT NOT NULL DEFAULT 'MEDIUM',
    title TEXT NOT NULL,
    message TEXT,
    acknowledged INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
