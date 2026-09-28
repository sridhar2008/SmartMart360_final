from __future__ import annotations

import base64
from contextlib import asynccontextmanager, contextmanager
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path
import re
import sqlite3
import sys
from threading import Lock
import time
from typing import Any, Generator

try:
    import cv2
except Exception:  # pragma: no cover - optional runtime dependency
    cv2 = None

try:
    import numpy as np
except Exception:  # pragma: no cover - optional runtime dependency
    np = None

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from starlette.background import BackgroundTask

from backend.database.seed import seed_default_data

try:
    from ultralytics import YOLO
except Exception:  # pragma: no cover - optional runtime dependency
    YOLO = None

try:
    import qrcode
except Exception:  # pragma: no cover - optional runtime dependency
    qrcode = None

BASE_DIR = Path(__file__).resolve().parent
WORKSPACE_ROOT = BASE_DIR.parent
AI_PROJECT_ROOT = WORKSPACE_ROOT / "SIH_AI-main" / "SIH_AI-main"
if str(AI_PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(AI_PROJECT_ROOT))

DB_PATH = BASE_DIR / "database" / "smartmart.db"
SCHEMA_PATH = BASE_DIR / "database" / "schema.sql"
MODEL: Any = None
CAMERA_STREAM_LOCK = Lock()

try:
    from src.detection.product_detection import detect_from_frame, resolve_model_path as resolve_ai_model_path
except Exception:
    detect_from_frame = None
    resolve_ai_model_path = None


def get_utc_iso_now() -> str:
    """Return current UTC time formatted as an ISO-8601 string."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


@contextmanager
def get_connection() -> Generator[sqlite3.Connection, None, None]:
    """Provide a transactional database connection with guaranteed cleanup."""
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def ensure_database() -> None:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(DB_PATH) as conn:
        schema_sql = SCHEMA_PATH.read_text(encoding="utf-8")
        conn.executescript(schema_sql)
        seed_default_data(conn)


def resolve_model_path() -> str:
    project_root = AI_PROJECT_ROOT
    preferred = [
        WORKSPACE_ROOT / "yolov8n.pt",
        WORKSPACE_ROOT / "yolo11n.pt",
        project_root / "runs" / "detect" / "train-2" / "weights" / "best.pt",
        project_root / "runs" / "detect" / "train-2" / "weights" / "last.pt",
        project_root / "yolov8n.pt",
        project_root / "yolo11n.pt",
        BASE_DIR / "yolov8n.pt",
        BASE_DIR / "yolo11n.pt",
    ]

    for candidate in preferred:
        if candidate.exists():
            return str(candidate)

    for match in sorted({path for path in WORKSPACE_ROOT.glob("*.pt") if path.name.lower().startswith("yolo")}, key=lambda p: p.name.lower()):
        if match.exists():
            return str(match)

    raise FileNotFoundError(
        "YOLO model missing. Expected model file at "
        f"{WORKSPACE_ROOT / 'yolov8n.pt'}"
    )


def ensure_model() -> Any:
    global MODEL
    if MODEL is not None or YOLO is None:
        return MODEL
    MODEL = YOLO(resolve_model_path())
    return MODEL


def decode_image_from_data_uri(image_data: str) -> bytes | None:
    if not image_data or not isinstance(image_data, str):
        return None
    match = re.search(r"data:image/(?:png|jpeg|jpg);base64,(.*)", image_data, flags=re.IGNORECASE)
    encoded = match.group(1) if match else image_data
    try:
        return base64.b64decode(encoded, validate=False)
    except Exception:
        return None


def normalize_product_name(name: str) -> str:
    if not isinstance(name, str):
        return ""

    cleaned = re.sub(r"[^a-z0-9]+", " ", name.strip().lower()).strip()
    aliases = {
        "water bottle": "Water bottle",
        "bottle": "Water bottle",
        "water_bottle": "Water bottle",
        "jinthaa": "Jinthaaa",
        "jinthaaa": "Jinthaaa",
        "jinthaa juice": "Jinthaaa",
        "jinthaaa juice": "Jinthaaa",
        "jinthaa_juice": "Jinthaaa",
        "jinthaaa_juice": "Jinthaaa",
        "juice": "Jinthaaa",
        "lifebuoy": "Lifebuoy",
        "soap": "Lifebuoy",
        "dhal": "Dhal",
        "person": "Person",
    }
    return aliases.get(cleaned, name.strip())


def detect_products_from_image(image_data: str) -> list[dict[str, Any]]:
    if cv2 is None or np is None:
        return []

    if detect_from_frame is not None:
        image_bytes = decode_image_from_data_uri(image_data)
        if image_bytes is None:
            return []
        array = np.frombuffer(image_bytes, dtype=np.uint8)
        frame = cv2.imdecode(array, cv2.IMREAD_COLOR)
        if frame is None:
            return []
        detections = detect_from_frame(frame)
        if detections:
            aggregated: dict[str, int] = {}
            for item in detections:
                name = str(item.get("class_name") or "").strip()
                if not name:
                    continue
                normalized_name = normalize_product_name(name)
                count = int(item.get("count") or 1)
                aggregated[normalized_name] = aggregated.get(normalized_name, 0) + count
            return [{"name": name, "count": count} for name, count in sorted(aggregated.items())]
        return []

    if YOLO is None:
        return []
    image_bytes = decode_image_from_data_uri(image_data)
    if image_bytes is None:
        return []

    array = np.frombuffer(image_bytes, dtype=np.uint8)
    frame = cv2.imdecode(array, cv2.IMREAD_COLOR)
    if frame is None:
        return []

    model = ensure_model()
    results = model.track(frame, persist=True, tracker="bytetrack.yaml", verbose=False, conf=0.25)

    aggregated: dict[str, int] = {}
    for result in results:
        names = getattr(model, "names", {})
        for box in getattr(result, "boxes", []) or []:
            if hasattr(box, "conf") and hasattr(box.conf, "__len__"):
                conf = float(box.conf[0]) if len(box.conf) > 0 else 0.0
            else:
                conf = 0.0
            if conf < 0.25:
                continue
            cls_index = int(box.cls[0]) if hasattr(box, "cls") and hasattr(box.cls, "__len__") and len(box.cls) > 0 else 0
            name = str(names.get(cls_index, str(cls_index))).strip()
            if not name:
                continue
            aggregated[name] = aggregated.get(name, 0) + 1

    return [{"name": name, "count": count} for name, count in sorted(aggregated.items())]


QUEUE_CAMERA_STREAM_LOCK = Lock()


def detect_people_from_image(image_data: str) -> dict[str, Any]:
    if cv2 is None or np is None:
        return {"people_count": 0, "detections": []}

    image_bytes = decode_image_from_data_uri(image_data)
    if image_bytes is None:
        return {"people_count": 0, "detections": []}

    array = np.frombuffer(image_bytes, dtype=np.uint8)
    frame = cv2.imdecode(array, cv2.IMREAD_COLOR)
    if frame is None:
        return {"people_count": 0, "detections": []}

    if YOLO is None:
        return {"people_count": 0, "detections": []}

    model = ensure_model()
    results = model.track(frame, persist=True, tracker="bytetrack.yaml", verbose=False, conf=0.25)

    people_detections: list[dict[str, Any]] = []
    for result in results:
        names = getattr(model, "names", {})
        boxes = getattr(result, "boxes", []) or []
        for box in boxes:
            if hasattr(box, "conf") and hasattr(box.conf, "__len__") and len(box.conf) > 0:
                conf = float(box.conf[0])
            else:
                conf = float(getattr(box, "conf", 0.0) or 0.0)
            if conf < 0.25:
                continue

            if hasattr(box, "cls") and hasattr(box.cls, "__len__") and len(box.cls) > 0:
                cls_index = int(box.cls[0])
            else:
                cls_index = int(getattr(box, "cls", 0) or 0)

            class_name = str(names.get(cls_index, str(cls_index))).strip().lower()

            if class_name in {"person", "human", "customer", "shopper"}:
                xyxy = [round(float(c), 1) for c in box.xyxy[0]] if hasattr(box, "xyxy") and len(box.xyxy) > 0 else []
                track_id = int(box.id[0]) if hasattr(box, "id") and box.id is not None and len(box.id) > 0 else None
                people_detections.append({
                    "class": "person",
                    "confidence": round(conf, 2),
                    "box": xyxy,
                    "track_id": track_id,
                })

    # Update camera device status in database
    try:
        with get_connection() as conn:
            conn.execute(
                "UPDATE devices SET status = 'ONLINE', last_seen = ? WHERE device_id = 'CAMERA-QUEUE'",
                (get_utc_iso_now(),),
            )
    except Exception:
        pass

    return {
        "people_count": len(people_detections),
        "detections": people_detections,
    }


def create_alert(
    alert_type: str,
    title: str,
    message: str,
    severity: str = "MEDIUM",
    conn: sqlite3.Connection | None = None,
) -> None:
    if conn is not None:
        existing = conn.execute(
            "SELECT id FROM alerts WHERE type = ? AND title = ? AND acknowledged = 0 LIMIT 1",
            (alert_type, title),
        ).fetchone()
        if existing is not None:
            return
        conn.execute(
            "INSERT INTO alerts(type, severity, title, message) VALUES (?, ?, ?, ?)",
            (alert_type, severity, title, message),
        )
        return

    with get_connection() as c:
        existing = c.execute(
            "SELECT id FROM alerts WHERE type = ? AND title = ? AND acknowledged = 0 LIMIT 1",
            (alert_type, title),
        ).fetchone()
        if existing is not None:
            return
        c.execute(
            "INSERT INTO alerts(type, severity, title, message) VALUES (?, ?, ?, ?)",
            (alert_type, severity, title, message),
        )


def sync_product_alert(product_id: int) -> None:
    with get_connection() as conn:
        row = conn.execute(
            "SELECT id, name, current_quantity, maximum_quantity, low_stock_limit FROM products WHERE id = ?",
            (product_id,),
        ).fetchone()
        if row is None:
            return
        if int(row["current_quantity"]) <= int(row["low_stock_limit"]):
            create_alert(
                "LOW_STOCK",
                f"{row['name']} low stock",
                f"{row['name']} is at or below the refill threshold ({row['current_quantity']} units left).",
                "MEDIUM",
                conn=conn,
            )
        if int(row["current_quantity"]) == 0:
            open_task = conn.execute(
                "SELECT id FROM tasks WHERE product_id = ? AND type = 'RESTOCK' AND status != 'COMPLETED' LIMIT 1",
                (product_id,),
            ).fetchone()
            if open_task is None:
                conn.execute(
                    """
                    INSERT INTO tasks(type, title, description, product_id, priority, status, verification_result)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        "RESTOCK",
                        f"Restock {row['name']}",
                        f"{row['name']} is out of stock and requires immediate replenishment.",
                        product_id,
                        1,
                        "UNASSIGNED",
                        "PENDING",
                    ),
                )
        elif int(row["current_quantity"]) >= int(row["maximum_quantity"]):
            conn.execute(
                """
                UPDATE tasks
                SET status = 'COMPLETED', completed_at = ?
                WHERE product_id = ? AND type = 'RESTOCK' AND status != 'COMPLETED'
                """,
                (get_utc_iso_now(), product_id),
            )


def sync_queue_alert(queue_waiting: int, support_limit: int) -> None:
    if queue_waiting < support_limit:
        return
    create_alert(
        "QUEUE_SUPPORT",
        "Queue support required",
        f"Queue size ({queue_waiting}) has reached the support limit ({support_limit}).",
        "HIGH",
    )


ensure_database()


class StaffCreateRequest(BaseModel):
    name: str = Field(..., min_length=1)
    employee_code: str = Field(..., min_length=1)
    section: str = Field(default="Grocery")
    role: str = Field(default="stocker")


class StaffUpdateRequest(BaseModel):
    name: str | None = None
    section: str | None = None
    role: str | None = None


class TaskCreateRequest(BaseModel):
    type: str = Field(default="MANUAL_TASK")
    title: str = Field(..., min_length=1)
    description: str | None = None
    staff_id: int | None = None
    product_id: int | None = None
    priority: int = Field(default=2)
    status: str = Field(default="UNASSIGNED")


class QueueUpdateRequest(BaseModel):
    people_waiting: int | None = None
    average_service_time: int | None = None
    estimated_wait: int | None = None
    support_limit: int | None = None


class TaskStatusUpdateRequest(BaseModel):
    status: str | None = None
    staff_id: int | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    ensure_database()
    yield


app = FastAPI(title="SmartMart360 Backend", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def standard_response(data: Any, success: bool = True) -> dict[str, Any]:
    return {"success": success, "data": data}


@app.get("/health")
def health() -> dict[str, Any]:
    local_ai_available = False
    local_ai_model = None
    if YOLO is not None:
        try:
            local_ai_model = Path(resolve_model_path()).name
            local_ai_available = cv2 is not None and np is not None
        except (FileNotFoundError, OSError):
            pass

    return standard_response({
        "status": "ok",
        "mode": "live",
        "backend": "fastapi",
        "local_ai": {
            "available": local_ai_available,
            "connected": MODEL is not None or detect_from_frame is not None,
            "model": local_ai_model,
            "tracker": "ByteTrack" if MODEL is not None or detect_from_frame is not None else None,
        },
    })


def camera_mjpeg_frames(camera: Any, first_frame: Any, release_camera: Any):
    try:
        frame = first_frame
        while frame is not None:
            encoded, buffer = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 78])
            if encoded:
                yield (
                    b"--frame\r\nContent-Type: image/jpeg\r\nContent-Length: "
                    + str(len(buffer)).encode("ascii")
                    + b"\r\n\r\n"
                    + buffer.tobytes()
                    + b"\r\n"
                )
            time.sleep(0.033)  # throttle to ~30 FPS
            success, frame = camera.read()
            if not success:
                break
    finally:
        release_camera()


@app.get("/camera/stream")
def camera_stream() -> StreamingResponse:
    if cv2 is None:
        raise HTTPException(status_code=503, detail="OpenCV camera support is unavailable.")
    if not CAMERA_STREAM_LOCK.acquire(blocking=False):
        raise HTTPException(status_code=503, detail="The camera is already serving another live stream.")

    camera = None
    try:
        camera = cv2.VideoCapture(0, cv2.CAP_DSHOW)
        if not camera.isOpened():
            raise RuntimeError("No camera could be opened.")
        success, first_frame = camera.read()
        if not success or first_frame is None:
            raise RuntimeError("The camera did not return a video frame.")
    except Exception as exc:
        if camera is not None:
            try:
                camera.release()
            except Exception:
                pass
        CAMERA_STREAM_LOCK.release()
        raise HTTPException(status_code=503, detail="The camera could not provide a live frame.") from exc

    released = False

    def release_camera() -> None:
        nonlocal released
        if released:
            return
        released = True
        try:
            camera.release()
        except Exception:
            pass
        finally:
            CAMERA_STREAM_LOCK.release()

    return StreamingResponse(
        camera_mjpeg_frames(camera, first_frame, release_camera),
        media_type="multipart/x-mixed-replace; boundary=frame",
        background=BackgroundTask(release_camera),
    )


@app.get("/products")
def list_products() -> dict[str, Any]:
    with get_connection() as conn:
        rows = conn.execute(
            """
            SELECT p.*, r.name AS rack_name, lc.device_id AS load_cell_id_value
            FROM products p
            LEFT JOIN racks r ON r.id = p.rack_id
            LEFT JOIN load_cells lc ON lc.id = p.load_cell_id
            ORDER BY p.id ASC
            """
        ).fetchall()
    payload = [
        {
            "id": row["id"],
            "name": row["name"],
            "sku": row["sku"],
            "category": row["category"],
            "unit_weight_grams": row["unit_weight_grams"],
            "maximum_quantity": row["maximum_quantity"],
            "quantity": row["current_quantity"],
            "current_quantity": row["current_quantity"],
            "low_stock_limit": row["low_stock_limit"],
            "rack_id": row["rack_id"],
            "rack_name": row["rack_name"],
            "load_cell_id": row["load_cell_id"],
            "load_cell_device_id": row["load_cell_id_value"],
        }
        for row in rows
    ]
    return standard_response(payload)


@app.post("/shelf/detect")
def shelf_detect(payload: dict[str, Any]) -> dict[str, Any]:
    detections = payload.get("detections")
    if payload.get("image"):
        try:
            detections = detect_products_from_image(payload["image"])
        except FileNotFoundError as exc:
            raise HTTPException(status_code=500, detail=str(exc)) from exc
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"Inference failed: {exc}") from exc

    if not isinstance(detections, list):
        raise HTTPException(status_code=400, detail="detections must be a list of items with a name and count")

    normalized_detections: list[dict[str, Any]] = []
    with get_connection() as conn:
        for item in detections:
            if not isinstance(item, dict):
                continue
            original_name = str(item.get("name") or item.get("product") or "").strip()
            if not original_name:
                continue

            normalized_name = normalize_product_name(original_name)
            candidate_names = {original_name, normalized_name}
            if normalized_name == original_name:
                candidate_names = {original_name}

            count = int(item.get("count") or item.get("quantity") or 0)
            if count < 0:
                count = 0

            row = None
            for candidate in candidate_names:
                row = conn.execute(
                    "SELECT id, name, current_quantity, maximum_quantity, sku FROM products WHERE lower(name) = lower(?) OR lower(sku) = lower(?) LIMIT 1",
                    (candidate, candidate),
                ).fetchone()
                if row is not None:
                    break

            if row is None:
                continue
            updated_quantity = min(int(row["maximum_quantity"]), count)
            conn.execute(
                "UPDATE products SET current_quantity = ?, updated_at = ? WHERE id = ?",
                (updated_quantity, get_utc_iso_now(), row["id"]),
            )
            normalized_detections.append(
                {
                    "id": row["id"],
                    "name": row["name"],
                    "sku": row["sku"],
                    "count": updated_quantity,
                }
            )

    for item in normalized_detections:
        sync_product_alert(item["id"])

    return standard_response(normalized_detections)


@app.get("/staff")
def list_staff() -> dict[str, Any]:
    with get_connection() as conn:
        rows = conn.execute(
            "SELECT * FROM staff ORDER BY id ASC"
        ).fetchall()
    payload = [
        {
            "id": row["id"],
            "name": row["name"],
            "employee_code": row["employee_code"],
            "section": row["section"],
            "role": row["role"],
            "qr_token": row["qr_token"],
            "checked_in": bool(row["checked_in"]),
            "last_check_in": row["last_check_in"],
            "last_check_out": row["last_check_out"],
        }
        for row in rows
    ]
    return standard_response(payload)


@app.get("/staff/{staff_id}/qr")
def staff_qr(staff_id: int) -> Response:
    if qrcode is None:
        raise HTTPException(status_code=503, detail="QR generation is unavailable")

    with get_connection() as conn:
        staff_member = conn.execute("SELECT id FROM staff WHERE id = ?", (staff_id,)).fetchone()
    if staff_member is None:
        raise HTTPException(status_code=404, detail="Staff not found")

    code = f"SMARTMART360-STAFF:{staff_id}"
    qr_code = qrcode.QRCode(version=1, box_size=8, border=4)
    qr_code.add_data(code)
    qr_code.make(fit=True)
    image = qr_code.make_image(fill_color="black", back_color="white")
    output = BytesIO()
    image.save(output, format="PNG")
    return Response(content=output.getvalue(), media_type="image/png", headers={"Cache-Control": "no-store"})


@app.post("/staff")
def create_staff(payload: StaffCreateRequest) -> dict[str, Any]:
    token = f"SMARTMART-{payload.employee_code.upper()}"
    with get_connection() as conn:
        existing = conn.execute(
            "SELECT id FROM staff WHERE employee_code = ? OR qr_token = ?",
            (payload.employee_code, token),
        ).fetchone()
        if existing:
            raise HTTPException(status_code=400, detail="Staff already exists")

        cursor = conn.execute(
            """
            INSERT INTO staff(name, employee_code, section, role, qr_token, checked_in, last_check_in, last_check_out)
            VALUES (?, ?, ?, ?, ?, 0, NULL, NULL)
            """,
            (payload.name, payload.employee_code, payload.section, payload.role, token),
        )
        staff_id = cursor.lastrowid
        row = conn.execute("SELECT * FROM staff WHERE id = ?", (staff_id,)).fetchone()

    return standard_response(
        {
            "id": row["id"],
            "name": row["name"],
            "employee_code": row["employee_code"],
            "section": row["section"],
            "role": row["role"],
            "qr_token": row["qr_token"],
            "checked_in": bool(row["checked_in"]),
            "last_check_in": row["last_check_in"],
            "last_check_out": row["last_check_out"],
        }
    )


@app.post("/staff/{staff_id}/check-in")
def check_in_staff(staff_id: int) -> dict[str, Any]:
    now = get_utc_iso_now()
    with get_connection() as conn:
        row = conn.execute("SELECT * FROM staff WHERE id = ?", (staff_id,)).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="Staff not found")
        conn.execute(
            "UPDATE staff SET checked_in = 1, last_check_in = ?, last_check_out = NULL WHERE id = ?",
            (now, staff_id),
        )
        updated = conn.execute("SELECT * FROM staff WHERE id = ?", (staff_id,)).fetchone()
    return standard_response(
        {
            "id": updated["id"],
            "name": updated["name"],
            "checked_in": bool(updated["checked_in"]),
            "last_check_in": updated["last_check_in"],
        }
    )


@app.post("/staff/{staff_id}/check-out")
def check_out_staff(staff_id: int) -> dict[str, Any]:
    now = get_utc_iso_now()
    with get_connection() as conn:
        row = conn.execute("SELECT * FROM staff WHERE id = ?", (staff_id,)).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="Staff not found")
        conn.execute(
            "UPDATE staff SET checked_in = 0, last_check_out = ? WHERE id = ?",
            (now, staff_id),
        )
        updated = conn.execute("SELECT * FROM staff WHERE id = ?", (staff_id,)).fetchone()
    return standard_response(
        {
            "id": updated["id"],
            "name": updated["name"],
            "checked_in": bool(updated["checked_in"]),
            "last_check_out": updated["last_check_out"],
        }
    )


@app.get("/queue")
def get_queue() -> dict[str, Any]:
    with get_connection() as conn:
        row = conn.execute("SELECT * FROM queue_status LIMIT 1").fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Queue data not found")
    return standard_response(
        {
            "people_waiting": row["people_waiting"],
            "average_service_time": row["average_service_time"],
            "estimated_wait": row["estimated_wait"],
            "support_limit": row["support_limit"],
            "updated_at": row["updated_at"],
        }
    )


@app.post("/queue")
def update_queue(payload: QueueUpdateRequest) -> dict[str, Any]:
    with get_connection() as conn:
        row = conn.execute("SELECT * FROM queue_status WHERE id = 1").fetchone()
        if row is None:
            conn.execute(
                """
                INSERT INTO queue_status (id, people_waiting, average_service_time, estimated_wait, support_limit, updated_at)
                VALUES (1, ?, ?, ?, ?, ?)
                """,
                (
                    payload.people_waiting if payload.people_waiting is not None else 0,
                    payload.average_service_time if payload.average_service_time is not None else 90,
                    payload.estimated_wait if payload.estimated_wait is not None else 0,
                    payload.support_limit if payload.support_limit is not None else 5,
                    get_utc_iso_now(),
                ),
            )
        else:
            conn.execute(
                """
                UPDATE queue_status
                SET people_waiting = COALESCE(?, people_waiting),
                    average_service_time = COALESCE(?, average_service_time),
                    estimated_wait = COALESCE(?, estimated_wait),
                    support_limit = COALESCE(?, support_limit),
                    updated_at = ?
                WHERE id = 1
                """,
                (
                    payload.people_waiting,
                    payload.average_service_time,
                    payload.estimated_wait,
                    payload.support_limit,
                    get_utc_iso_now(),
                ),
            )
        updated = conn.execute("SELECT * FROM queue_status WHERE id = 1").fetchone()
    sync_queue_alert(updated["people_waiting"], updated["support_limit"])
    return standard_response(
        {
            "people_waiting": updated["people_waiting"],
            "average_service_time": updated["average_service_time"],
            "estimated_wait": updated["estimated_wait"],
            "support_limit": updated["support_limit"],
            "updated_at": updated["updated_at"],
        }
    )


@app.post("/queue/detect")
def queue_detect(payload: dict[str, Any]) -> dict[str, Any]:
    people_count = payload.get("count")
    detections: list[dict[str, Any]] = []

    if payload.get("image"):
        try:
            detection_result = detect_people_from_image(payload["image"])
            people_count = detection_result["people_count"]
            detections = detection_result["detections"]
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"Queue inference failed: {exc}") from exc

    if people_count is None:
        raise HTTPException(status_code=400, detail="Must provide 'image' or 'count'")

    people_count = max(0, int(people_count))

    with get_connection() as conn:
        row = conn.execute("SELECT * FROM queue_status WHERE id = 1").fetchone()
        avg_time = int(row["average_service_time"]) if row else 90
        supp_limit = int(row["support_limit"]) if row else 5
        est_wait = round((people_count * avg_time) / 60.0, 1)

        if row is None:
            conn.execute(
                """
                INSERT INTO queue_status (id, people_waiting, average_service_time, estimated_wait, support_limit, updated_at)
                VALUES (1, ?, ?, ?, ?, ?)
                """,
                (people_count, avg_time, est_wait, supp_limit, get_utc_iso_now()),
            )
        else:
            conn.execute(
                """
                UPDATE queue_status
                SET people_waiting = ?,
                    estimated_wait = ?,
                    updated_at = ?
                WHERE id = 1
                """,
                (people_count, est_wait, get_utc_iso_now()),
            )
        updated = conn.execute("SELECT * FROM queue_status WHERE id = 1").fetchone()

    sync_queue_alert(updated["people_waiting"], updated["support_limit"])

    return standard_response({
        "people_waiting": updated["people_waiting"],
        "people_count": updated["people_waiting"],
        "average_service_time": updated["average_service_time"],
        "estimated_wait": updated["estimated_wait"],
        "support_limit": updated["support_limit"],
        "updated_at": updated["updated_at"],
        "detections": detections,
    })


@app.get("/camera/queue/stream")
def queue_camera_stream() -> StreamingResponse:
    if cv2 is None:
        raise HTTPException(status_code=503, detail="OpenCV camera support is unavailable.")
    if not QUEUE_CAMERA_STREAM_LOCK.acquire(blocking=False):
        raise HTTPException(status_code=503, detail="The queue camera is already serving another live stream.")

    camera = None
    try:
        camera = cv2.VideoCapture(1, cv2.CAP_DSHOW)
        if not camera.isOpened():
            camera.release()
            camera = cv2.VideoCapture(0, cv2.CAP_DSHOW)
        if not camera.isOpened():
            raise RuntimeError("No camera could be opened for queue monitoring.")
        success, first_frame = camera.read()
        if not success or first_frame is None:
            raise RuntimeError("The queue camera did not return a video frame.")
    except Exception as exc:
        if camera is not None:
            try:
                camera.release()
            except Exception:
                pass
        QUEUE_CAMERA_STREAM_LOCK.release()
        raise HTTPException(status_code=503, detail="The queue camera could not provide a live frame.") from exc

    released = False

    def release_camera() -> None:
        nonlocal released
        if released:
            return
        released = True
        try:
            camera.release()
        except Exception:
            pass
        finally:
            QUEUE_CAMERA_STREAM_LOCK.release()

    return StreamingResponse(
        camera_mjpeg_frames(camera, first_frame, release_camera),
        media_type="multipart/x-mixed-replace; boundary=frame",
        headers={"Access-Control-Allow-Origin": "*", "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0"},
        background=BackgroundTask(release_camera),
    )


@app.get("/tasks")
def list_tasks() -> dict[str, Any]:
    with get_connection() as conn:
        rows = conn.execute(
            "SELECT * FROM tasks ORDER BY created_at DESC"
        ).fetchall()
    payload = [
        {
            "id": row["id"],
            "type": row["type"],
            "title": row["title"],
            "description": row["description"],
            "staff_id": row["staff_id"],
            "product_id": row["product_id"],
            "priority": row["priority"],
            "status": row["status"],
            "verification_result": row["verification_result"],
            "created_at": row["created_at"],
            "completed_at": row["completed_at"],
        }
        for row in rows
    ]
    return standard_response(payload)


@app.post("/tasks")
def create_task(payload: TaskCreateRequest) -> dict[str, Any]:
    with get_connection() as conn:
        if payload.type.upper() == "RESTOCK" and payload.product_id is not None:
            existing = conn.execute(
                """
                SELECT id, type, title, status
                FROM tasks
                WHERE type = 'RESTOCK' AND product_id = ? AND status != 'COMPLETED'
                ORDER BY id DESC LIMIT 1
                """,
                (payload.product_id,),
            ).fetchone()
            if existing is not None:
                return standard_response({
                    "id": existing["id"],
                    "type": existing["type"],
                    "title": existing["title"],
                    "status": existing["status"],
                    "existing": True,
                })

        cursor = conn.execute(
            """
            INSERT INTO tasks(type, title, description, staff_id, product_id, priority, status, verification_result)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                payload.type,
                payload.title,
                payload.description,
                payload.staff_id,
                payload.product_id,
                payload.priority,
                payload.status,
                "PENDING",
            ),
        )
        task_id = cursor.lastrowid
        row = conn.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
    return standard_response(
        {
            "id": row["id"],
            "type": row["type"],
            "title": row["title"],
            "status": row["status"],
            "existing": False,
        }
    )


@app.patch("/tasks/{task_id}")
def update_task(task_id: int, payload: TaskStatusUpdateRequest) -> dict[str, Any]:
    with get_connection() as conn:
        existing = conn.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
        if existing is None:
            raise HTTPException(status_code=404, detail="Task not found")

        new_status = (payload.status or existing["status"]).upper()
        new_staff_id = payload.staff_id if payload.staff_id is not None else existing["staff_id"]
        completed_at = existing["completed_at"]
        if new_status == "COMPLETED":
            completed_at = get_utc_iso_now()
        elif new_status in {"UNASSIGNED", "ASSIGNED"}:
            completed_at = None

        conn.execute(
            """
            UPDATE tasks
            SET status = ?, staff_id = ?, completed_at = ?
            WHERE id = ?
            """,
            (new_status, new_staff_id, completed_at, task_id),
        )
        row = conn.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
    return standard_response(
        {
            "id": row["id"],
            "status": row["status"],
            "staff_id": row["staff_id"],
        }
    )


@app.post("/tasks/{task_id}/status")
def update_task_status(task_id: int, payload: TaskStatusUpdateRequest) -> dict[str, Any]:
    return update_task(task_id, payload)


@app.get("/alerts")
def list_alerts() -> dict[str, Any]:
    with get_connection() as conn:
        rows = conn.execute("SELECT * FROM alerts ORDER BY created_at DESC").fetchall()
    return standard_response([
        {
            "id": row["id"],
            "type": row["type"],
            "severity": row["severity"],
            "title": row["title"],
            "message": row["message"],
            "acknowledged": bool(row["acknowledged"]),
            "created_at": row["created_at"],
        }
        for row in rows
    ])


@app.get("/devices")
def list_devices() -> dict[str, Any]:
    with get_connection() as conn:
        rows = conn.execute("SELECT * FROM devices ORDER BY id ASC").fetchall()
    return standard_response([
        {
            "id": row["id"],
            "device_id": row["device_id"],
            "device_type": row["device_type"],
            "rack_id": row["rack_id"],
            "status": row["status"],
            "last_seen": row["last_seen"],
            "firmware_version": row["firmware_version"],
            "source": row["source"],
        }
        for row in rows
    ])


@app.get("/settings")
def get_settings() -> dict[str, Any]:
    with get_connection() as conn:
        row = conn.execute("SELECT * FROM settings LIMIT 1").fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Settings not found")
    return standard_response(
        {
            "low_stock_limit": row["low_stock_limit"],
            "queue_support_limit": row["queue_support_limit"],
            "average_service_time": row["average_service_time"],
            "weight_tolerance_percent": row["weight_tolerance_percent"],
            "event_cooldown_seconds": row["event_cooldown_seconds"],
            "device_timeout_seconds": row["device_timeout_seconds"],
            "ai_confidence_threshold": row["ai_confidence_threshold"],
            "event_correlation_window_ms": row["event_correlation_window_ms"],
        }
    )


@app.post("/products/{product_id}/adjust")
def adjust_product_quantity(product_id: int, payload: dict[str, Any]) -> dict[str, Any]:
    delta = int(payload.get("delta", 0))
    with get_connection() as conn:
        row = conn.execute("SELECT * FROM products WHERE id = ?", (product_id,)).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="Product not found")

        new_quantity = max(0, min(int(row["maximum_quantity"]), int(row["current_quantity"]) + delta))
        conn.execute(
            "UPDATE products SET current_quantity = ?, updated_at = ? WHERE id = ?",
            (new_quantity, get_utc_iso_now(), product_id),
        )
        updated = conn.execute("SELECT * FROM products WHERE id = ?", (product_id,)).fetchone()
    sync_product_alert(product_id)
    return standard_response(
        {
            "id": updated["id"],
            "name": updated["name"],
            "current_quantity": updated["current_quantity"],
            "maximum_quantity": updated["maximum_quantity"],
        }
    )


@app.post("/settings")
def update_settings(payload: dict[str, Any]) -> dict[str, Any]:
    with get_connection() as conn:
        conn.execute(
            """
            UPDATE settings SET
                low_stock_limit = COALESCE(?, low_stock_limit),
                queue_support_limit = COALESCE(?, queue_support_limit),
                average_service_time = COALESCE(?, average_service_time),
                weight_tolerance_percent = COALESCE(?, weight_tolerance_percent),
                event_cooldown_seconds = COALESCE(?, event_cooldown_seconds),
                device_timeout_seconds = COALESCE(?, device_timeout_seconds),
                ai_confidence_threshold = COALESCE(?, ai_confidence_threshold),
                event_correlation_window_ms = COALESCE(?, event_correlation_window_ms),
                updated_at = ?
            WHERE id = 1
            """,
            (
                payload.get("low_stock_limit"),
                payload.get("queue_support_limit"),
                payload.get("average_service_time"),
                payload.get("weight_tolerance_percent"),
                payload.get("event_cooldown_seconds"),
                payload.get("device_timeout_seconds"),
                payload.get("ai_confidence_threshold"),
                payload.get("event_correlation_window_ms"),
                get_utc_iso_now(),
            ),
        )
    return get_settings()


@app.get("/analytics/dwell")
def analytics_dwell() -> dict[str, Any]:
    return standard_response({
        "average_dwell_seconds": 180,
        "source": "offline-demo",
        "mode": "queue-only",
    })


app.mount("/", StaticFiles(directory=str(WORKSPACE_ROOT), html=True), name="static")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("backend.main:app", host="0.0.0.0", port=8000, reload=False)
