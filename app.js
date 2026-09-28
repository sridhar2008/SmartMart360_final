"use strict";

const API_BASE = "http://localhost:8000";
const STORAGE_KEY = "smartmart360-demo";

function readStoredState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    return saved || {};
  } catch (error) {
    console.warn("Could not read saved app state.", error);
    return {};
  }
}

function persistLocalState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      products,
      staff,
      queue,
      served,
      lowStockLimit,
      queueLimit,
      tasks
    }));
  } catch (error) {
    console.warn("Could not save app state locally.", error);
  }
}

const products = [
  { id: 1, name: "Jinthaaa", weight: 218, quantity: 4, maximum: 4, cell: 1, shelf: "Rack A" },
  { id: 2, name: "Dhal", weight: 250, quantity: 4, maximum: 4, cell: 1, shelf: "Rack A" },
  { id: 3, name: "Water bottle", weight: 512, quantity: 4, maximum: 4, cell: 2, shelf: "Rack B" },
  { id: 4, name: "Lifebuoy", weight: 118, quantity: 4, maximum: 4, cell: 2, shelf: "Rack B" }
];

const staff = [
  { id: 1, name: "Ananya", section: "Grocery", checkedIn: true },
  { id: 2, name: "Kavin", section: "Checkout", checkedIn: true },
  { id: 3, name: "Meera", section: "Personal care", checkedIn: false }
];

const sections = ["Grocery", "Drinks", "Personal care", "Checkout"];

let queue = 4;
let served = 0;
let lowStockLimit = 2;
let queueLimit = 5;
let averageServiceTime = 90;
let tasks = [];
let currentPage = "overview";

// Cam 1 - Shelf Inventory Camera
let inventoryCameraStream = null;
let autoShelfDetectionTimer = null;
let autoShelfDetectionBusy = false;
let autoDetectEnabled = true;
let selectedCameraMode = "webcam"; // "webcam" or "backend"
let webcamConnected = false;
let backendCameraActive = false;
let lastDetectedItems = [];
let inventoryCaptureCanvas = null;

// Cam 2 - Queue Intelligence Camera
let queueCameraStream = null;
let queueAutoDetectTimer = null;
let queueAutoDetectBusy = false;
let queueAutoDetectEnabled = true;
let queueSelectedCameraMode = "webcam"; // "webcam" or "backend"
let queueWebcamConnected = false;
let queueBackendCameraActive = false;
let queueSelectedDeviceId = null;
let lastQueueDetections = [];
let queueCaptureCanvas = null;

// QR Scanner & App state
let cameraStream = null;
let scanFrame = null;
let scanning = false;
let aiVisionConnected = false;
let aiModelAvailable = false;
let initialPageRendered = false;
let reportRefreshTimer = null;
let heroSliderIndex = 0;
let heroSliderTimer = null;
let availableVideoDevices = [];

try {
  const saved = readStoredState();
  if (saved) {
    if (Array.isArray(saved.products) && saved.products.length >= 4) {
      saved.products.forEach((item, i) => {
        if (products[i] && Number.isInteger(item.quantity) && item.quantity >= 0 && item.quantity <= (item.maximum ?? 4)) {
          products[i].quantity = item.quantity;
        }
      });
    }

    if (Array.isArray(saved.staff) && saved.staff.length >= 3) {
      saved.staff.forEach((person, i) => {
        if (staff[i]) {
          staff[i].checkedIn = Boolean(person.checkedIn);
          if (sections.includes(person.section)) staff[i].section = person.section;
        }
      });
    }

    if (Array.isArray(saved.tasks)) tasks = saved.tasks;
    if (Number.isInteger(saved.queue) && saved.queue >= 0) queue = saved.queue;
    if (Number.isInteger(saved.served) && saved.served >= 0) served = saved.served;
    if (Number.isInteger(saved.lowStockLimit)) lowStockLimit = saved.lowStockLimit;
    if (Number.isInteger(saved.queueLimit)) queueLimit = saved.queueLimit;
  }
} catch (error) {
  console.warn("Could not load saved demo data.", error);
}

function buildLocalProductPayload() {
  return products.map(product => ({
    id: product.id,
    name: product.name,
    sku: `${product.name.toLowerCase().replace(/\s+/g, "-")}-${product.id}`,
    category: "Grocery",
    unit_weight_grams: product.weight,
    maximum_quantity: product.maximum,
    quantity: product.quantity,
    current_quantity: product.quantity,
    low_stock_limit: lowStockLimit,
    rack_id: product.cell,
    rack_name: product.shelf,
    load_cell_id: product.cell
  }));
}

function buildLocalStaffPayload() {
  return staff.map(person => ({
    id: person.id,
    name: person.name,
    employee_code: `EMP-${String(person.id).padStart(3, "0")}`,
    section: person.section,
    role: "staff",
    qr_token: `SMARTMART-${person.name.toUpperCase().replace(/\s+/g, "-")}`,
    checked_in: Boolean(person.checkedIn),
    last_check_in: null,
    last_check_out: null
  }));
}

function buildLocalTaskPayload() {
  return tasks.map((task, idx) => ({
    id: task.id ?? idx + 1,
    type: task.productId ? "RESTOCK" : "MANUAL_TASK",
    title: task.title,
    description: task.title,
    staff_id: staff.find(person => person.name === task.assignedTo)?.id ?? null,
    product_id: task.productId ?? null,
    priority: task.productId ? 1 : 2,
    status: task.status === "Completed" ? "COMPLETED" : (task.status === "Assigned" ? "ASSIGNED" : "UNASSIGNED")
  }));
}

function localFallbackResponse(path, options = {}) {
  const method = (options.method || "GET").toUpperCase();
  const route = path.split("?")[0];

  if (route === "/health") {
    return {
      success: true,
      data: {
        status: "ok",
        mode: "live",
        backend: "local-storage",
        local_ai: { connected: false, model: null, tracker: null }
      }
    };
  }

  if (route === "/products" && method === "GET") {
    return { success: true, data: buildLocalProductPayload() };
  }

  if (route === "/staff" && method === "GET") {
    return { success: true, data: buildLocalStaffPayload() };
  }

  if (route === "/queue" && method === "GET") {
    return {
      success: true,
      data: {
        people_waiting: queue,
        average_service_time: averageServiceTime,
        estimated_wait: Number(((queue * averageServiceTime) / 60).toFixed(1)),
        support_limit: queueLimit
      }
    };
  }

  if (route === "/queue/detect" && method === "POST") {
    const body = options.body ? JSON.parse(options.body) : {};
    if (Number.isInteger(Number(body.count))) queue = Number(body.count);
    persistLocalState();
    return {
      success: true,
      data: {
        people_waiting: queue,
        people_count: queue,
        average_service_time: averageServiceTime,
        estimated_wait: Number(((queue * averageServiceTime) / 60).toFixed(1)),
        support_limit: queueLimit,
        detections: []
      }
    };
  }

  if (route === "/tasks" && method === "GET") {
    return { success: true, data: buildLocalTaskPayload() };
  }

  if (route === "/settings" && method === "GET") {
    return {
      success: true,
      data: {
        low_stock_limit: lowStockLimit,
        queue_support_limit: queueLimit,
        average_service_time: averageServiceTime
      }
    };
  }

  if (route === "/settings" && method === "POST") {
    const body = options.body ? JSON.parse(options.body) : {};
    if (Number.isInteger(Number(body.low_stock_limit))) lowStockLimit = Number(body.low_stock_limit);
    if (Number.isInteger(Number(body.queue_support_limit))) queueLimit = Number(body.queue_support_limit);
    if (Number.isInteger(Number(body.average_service_time))) averageServiceTime = Number(body.average_service_time);
    persistLocalState();
    return {
      success: true,
      data: {
        low_stock_limit: lowStockLimit,
        queue_support_limit: queueLimit,
        average_service_time: averageServiceTime
      }
    };
  }

  const matchProductAdjust = /^\/products\/(\d+)\/adjust$/.exec(route);
  if (matchProductAdjust && method === "POST") {
    const productId = Number(matchProductAdjust[1]);
    const product = products.find(item => item.id === productId);
    const body = options.body ? JSON.parse(options.body) : {};
    const delta = Number(body.delta ?? 0);

    if (product) {
      product.quantity = Math.max(0, Math.min(product.maximum, product.quantity + delta));
      persistLocalState();
      return { success: true, data: { id: product.id, current_quantity: product.quantity, maximum_quantity: product.maximum } };
    }

    return { success: false, data: null };
  }

  const matchStaffToggle = /^\/staff\/(\d+)\/(check-in|check-out)$/.exec(route);
  if (matchStaffToggle && method === "POST") {
    const personId = Number(matchStaffToggle[1]);
    const person = staff.find(item => item.id === personId);
    if (person) {
      person.checkedIn = matchStaffToggle[2] === "check-in";
      persistLocalState();
      return { success: true, data: { id: person.id, checked_in: person.checkedIn } };
    }
  }

  const matchQueue = /^\/queue$/.exec(route);
  if (matchQueue && method === "POST") {
    const body = options.body ? JSON.parse(options.body) : {};
    if (Number.isInteger(Number(body.people_waiting))) queue = Number(body.people_waiting);
    if (Number.isInteger(Number(body.support_limit))) queueLimit = Number(body.support_limit);
    if (Number.isInteger(Number(body.average_service_time))) averageServiceTime = Number(body.average_service_time);
    persistLocalState();
    return {
      success: true,
      data: {
        people_waiting: queue,
        support_limit: queueLimit,
        average_service_time: averageServiceTime,
        estimated_wait: Number(((queue * averageServiceTime) / 60).toFixed(1))
      }
    };
  }

  if (route === "/tasks" && method === "POST") {
    const body = options.body ? JSON.parse(options.body) : {};
    const taskId = Math.max(0, ...tasks.map(t => Number(t.id) || 0)) + 1;
    const task = {
      id: taskId,
      productId: body.product_id ? Number(body.product_id) : null,
      title: body.title || "New task",
      assignedTo: body.staff_id ? (staff.find(person => person.id === body.staff_id)?.name || "") : "",
      status: body.status === "COMPLETED" ? "Completed" : (body.status === "ASSIGNED" ? "Assigned" : "Unassigned")
    };
    tasks.push(task);
    persistLocalState();
    return { success: true, data: { id: task.id, title: task.title, status: body.status || "UNASSIGNED" } };
  }

  const taskStatusMatch = /^\/tasks\/(\d+)\/status$/.exec(route);
  if (taskStatusMatch && method === "POST") {
    const taskId = Number(taskStatusMatch[1]);
    const task = tasks.find(item => item.id === taskId);
    const body = options.body ? JSON.parse(options.body) : {};
    if (task) {
      task.status = body.status === "COMPLETED" ? "Completed" : (body.status === "ASSIGNED" ? "Assigned" : task.status);
      persistLocalState();
      return { success: true, data: { id: task.id, status: body.status || task.status } };
    }
  }

  const taskPatchMatch = /^\/tasks\/(\d+)$/.exec(route);
  if (taskPatchMatch && method === "PATCH") {
    const taskId = Number(taskPatchMatch[1]);
    const task = tasks.find(item => item.id === taskId);
    const body = options.body ? JSON.parse(options.body) : {};
    if (task) {
      task.status = body.status === "COMPLETED" ? "Completed" : (body.status === "ASSIGNED" ? "Assigned" : task.status);
      if (body.staff_id) {
        const person = staff.find(item => item.id === body.staff_id);
        task.assignedTo = person ? person.name : task.assignedTo;
      }
      persistLocalState();
      return { success: true, data: { id: task.id, status: task.status, staff_id: body.staff_id || null } };
    }
  }

  return { success: true, data: [] };
}

async function apiRequest(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options
  }).catch(error => {
    console.warn("Backend unavailable, using local fallback.", error);
    return null;
  });

  if (!response) {
    return localFallbackResponse(path, options);
  }

  if (!response.ok) {
    const message = await response.text();
    console.warn(`Backend request failed for ${path}: ${message}. Using local fallback.`);
    return localFallbackResponse(path, options);
  }

  return response.json();
}

async function updateDeviceList() {
  try {
    if (navigator.mediaDevices?.enumerateDevices) {
      const devices = await navigator.mediaDevices.enumerateDevices();
      availableVideoDevices = devices.filter(d => d.kind === "videoinput");
    }
  } catch (e) {
    console.warn("Could not enumerate video devices.", e);
  }
}

async function hydrateFromBackend() {
  try {
    const [healthResponse, productsResponse, staffResponse, queueResponse, tasksResponse, settingsResponse] = await Promise.all([
      fetch(`${API_BASE}/health`),
      fetch(`${API_BASE}/products`),
      fetch(`${API_BASE}/staff`),
      fetch(`${API_BASE}/queue`),
      fetch(`${API_BASE}/tasks`),
      fetch(`${API_BASE}/settings`)
    ]);

    if (healthResponse.ok) {
      const payload = await healthResponse.json();
      aiModelAvailable = Boolean(payload?.data?.local_ai?.available);
      aiVisionConnected = Boolean(payload?.data?.local_ai?.connected);
    }

    if (productsResponse.ok) {
      const payload = await productsResponse.json();
      if (Array.isArray(payload?.data) && payload.data.length) {
        const backendProducts = payload.data.map((item, index) => ({
          id: item.id ?? index + 1,
          name: item.name,
          weight: Number(item.unit_weight_grams ?? 0),
          quantity: Number(item.current_quantity ?? item.quantity ?? 0),
          maximum: Number(item.maximum_quantity ?? item.quantity ?? 4),
          cell: Number(item.load_cell_id ?? (index % 2 === 0 ? 1 : 2)),
          shelf: item.rack_name || (index % 2 === 0 ? "Rack A" : "Rack B")
        }));

        products.splice(0, products.length, ...backendProducts);
      }
    }

    if (staffResponse.ok) {
      const payload = await staffResponse.json();
      if (Array.isArray(payload?.data) && payload.data.length) {
        const backendStaff = payload.data.map(person => ({
          id: person.id,
          name: person.name,
          section: person.section || "Grocery",
          checkedIn: Boolean(person.checked_in)
        }));

        staff.splice(0, staff.length, ...backendStaff);
      }
    }

    if (queueResponse.ok) {
      const payload = await queueResponse.json();
      if (payload?.data) {
        queue = Number(payload.data.people_waiting ?? queue);
        queueLimit = Number(payload.data.support_limit ?? queueLimit);
        averageServiceTime = Number(payload.data.average_service_time ?? averageServiceTime);
      }
    }

    if (tasksResponse.ok) {
      const payload = await tasksResponse.json();
      if (Array.isArray(payload?.data)) {
        tasks = payload.data.map(task => ({
          id: task.id,
          productId: task.product_id ? Number(task.product_id) : null,
          title: task.title,
          assignedTo: task.staff_id ? (staff.find(person => person.id === task.staff_id)?.name || `Staff ${task.staff_id}`) : "",
          status: task.status === "COMPLETED" ? "Completed" : (task.status === "ASSIGNED" ? "Assigned" : "Unassigned")
        }));
      }
    }

    if (settingsResponse.ok) {
      const payload = await settingsResponse.json();
      if (payload?.data) {
        lowStockLimit = Number(payload.data.low_stock_limit ?? lowStockLimit);
        queueLimit = Number(payload.data.queue_support_limit ?? queueLimit);
        averageServiceTime = Number(payload.data.average_service_time ?? averageServiceTime);
      }
    }

    completeRestockTasksForFullStock();
    persistLocalState();
    await updateDeviceList();
  } catch (error) {
    const savedState = readStoredState();
    if (savedState.products) {
      products.splice(0, products.length, ...savedState.products);
    }
    if (savedState.staff) {
      staff.splice(0, staff.length, ...savedState.staff);
    }
    if (savedState.queue !== undefined) queue = Number(savedState.queue);
    if (savedState.served !== undefined) served = Number(savedState.served);
    if (savedState.lowStockLimit !== undefined) lowStockLimit = Number(savedState.lowStockLimit);
    if (savedState.queueLimit !== undefined) queueLimit = Number(savedState.queueLimit);
    if (Array.isArray(savedState.tasks)) tasks = savedState.tasks;
    console.warn("Backend not available, using saved local mode.", error);
  }
}

const main = document.getElementById("main");

function heading(title, description) {
  return `<p class="eyebrow">STORE OPERATIONS</p>
          <h1>${title}</h1>
          <p class="subtitle">${description}</p>`;
}

function metric(label, value, note) {
  return `<div class="metric">
            <span>${label}</span><strong>${value}</strong><small>${note}</small>
          </div>`;
}

function panel(title, content) {
  return `<section class="panel">
            <div class="panel-header"><h2>${title}</h2></div>
            ${content}
          </section>`;
}

function productStatus(product) {
  if (product.quantity === 0) return "Out of stock";
  if (product.quantity <= lowStockLimit) return "Low stock";
  return "Available";
}

function shelfWeight(cell) {
  return products
    .filter(product => product.cell === cell)
    .reduce((total, product) => total + product.weight * product.quantity, 0);
}

function openTaskCount(name) {
  return tasks.filter(task =>
    task.assignedTo === name && task.status !== "Completed"
  ).length;
}

function chooseStaff() {
  const available = staff.filter(person => person.checkedIn);

  available.sort((a, b) =>
    openTaskCount(a.name) - openTaskCount(b.name) ||
    tasks.filter(t => t.assignedTo === a.name).length -
    tasks.filter(t => t.assignedTo === b.name).length
  );

  return available[0] || null;
}

function hasOpenTaskForProduct(product) {
  if (!product) return false;
  const cleanName = (product.name || "").trim().toLowerCase();
  return tasks.some(task => {
    if (task.status === "Completed") return false;
    if (product.id && Number(task.productId) === Number(product.id)) return true;
    const taskTitle = (task.title || "").toLowerCase();
    return taskTitle === `refill ${cleanName}` || taskTitle === `restock ${cleanName}`;
  });
}

function addTask(title, productId = null) {
  if (hasOpenTaskForProduct({ id: productId, name: title.replace(/^(Refill|Restock)\s+/i, "") })) {
    return false;
  }

  const person = chooseStaff();
  const nextId = Math.max(0, ...tasks.map(t => Number(t.id) || 0)) + 1;
  const newTask = {
    id: nextId,
    productId: productId ? Number(productId) : null,
    title: title,
    assignedTo: person ? person.name : "",
    status: person ? "Assigned" : "Unassigned"
  };

  tasks.push(newTask);
  persistLocalState();

  apiRequest("/tasks", {
    method: "POST",
    body: JSON.stringify({
      type: productId ? "RESTOCK" : "MANUAL_TASK",
      title,
      description: title,
      staff_id: person?.id ?? null,
      product_id: productId ? Number(productId) : null,
      priority: productId ? 1 : 2,
      status: person ? "ASSIGNED" : "UNASSIGNED"
    })
  }).then(result => {
    if (result?.data?.existing) {
      const duplicateIndex = tasks.indexOf(newTask);
      if (duplicateIndex >= 0) tasks.splice(duplicateIndex, 1);
      persistLocalState();
      return;
    }
    if (result?.data?.id) {
      newTask.id = result.data.id;
      persistLocalState();
    }
  }).catch(error => console.warn("Could not save task to backend.", error));

  return true;
}

function completeRestockTasksForFullStock() {
  tasks.forEach(task => {
    if (task.status === "Completed" || !task.productId) return;

    const product = products.find(item => item.id === Number(task.productId));
    if (!product || product.quantity < product.maximum) return;

    task.status = "Completed";
    if (task.id) {
      apiRequest(`/tasks/${task.id}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "COMPLETED" })
      }).catch(error => console.warn("Could not complete full-stock restock task.", error));
    }
  });
}

function getConnectionStatus() {
  return {
    webcam: webcamConnected || queueWebcamConnected ? "Connected to live feed" : "Not connected",
    ai: aiVisionConnected ? "Connected to YOLOv8 + ByteTrack" : aiModelAvailable ? "Model available; inference ready" : "Not connected"
  };
}

function overviewPage() {
  const alerts = products.filter(product => product.quantity <= lowStockLimit);
  const openTasks = tasks.filter(task => task.status !== "Completed").length;
  const connectionState = getConnectionStatus();

  return heading("Store overview", "Your retail operations at a glance") +
    `<div class="hero-slider" aria-label="Retail operations slider">
      <div class="slide active" data-asset="retail-hero-1.svg">
        <div class="slide-copy">
          <span class="eyebrow accent">Smart retail insights</span>
          <h2>Turn your store into a smarter, faster shopping experience.</h2>
          <p>Track demand, react to stock changes, and keep service levels high across every aisle.</p>
          <div class="slide-actions">
            <button class="primary" data-target="inventory">View inventory</button>
            <button data-target="queue">Open queue</button>
          </div>
          <ul class="hero-stats">
            <li><strong>24/7</strong><span>live visibility</span></li>
            <li><strong>18%</strong><span>faster restock</span></li>
            <li><strong>94%</strong><span>service quality</span></li>
          </ul>
        </div>
        <div class="slide-visual">
          <img src="assets/retail-hero-1.svg" alt="Retail store dashboard overview" />
          <div class="visual-card">
            <span>New updates</span>
            <strong>+12% sales</strong>
            <small>Fresh stock · queue stable</small>
          </div>
        </div>
      </div>

      <div class="slide" data-asset="retail-hero-2.svg">
        <div class="slide-copy">
          <span class="eyebrow accent">Store performance</span>
          <h2>Prioritize queue flow and staff coverage in real time.</h2>
          <p>See support limits, customer flow, and task load before bottlenecks form on the floor.</p>
          <div class="slide-actions">
            <button class="primary" data-target="queue">Review queue</button>
            <button data-target="staff">Assign staff</button>
          </div>
          <ul class="hero-stats">
            <li><strong>${((queue * averageServiceTime) / 60).toFixed(1)} min</strong><span>avg. wait</span></li>
            <li><strong>${openTasks}</strong><span>staff alerts</span></li>
            <li><strong>3</strong><span>checkout lanes</span></li>
          </ul>
        </div>
        <div class="slide-visual">
          <img src="assets/retail-hero-2.svg" alt="Retail queue and staffing dashboard" />
          <div class="visual-card">
            <span>Live queue</span>
            <strong>${queue} waiting</strong>
            <small>Support limit: ${queueLimit}</small>
          </div>
        </div>
      </div>

      <div class="slide" data-asset="retail-hero-3.svg">
        <div class="slide-copy">
          <span class="eyebrow accent">Smart restocks</span>
          <h2>Keep stock levels healthy with proactive replenishment.</h2>
          <p>React early to low-stock risks and keep high-demand products available when customers need them.</p>
          <div class="slide-actions">
            <button class="primary" data-target="inventory">Manage stock</button>
            <button data-target="overview">Check alerts</button>
          </div>
          <ul class="hero-stats">
            <li><strong>${alerts.length}</strong><span>critical items</span></li>
            <li><strong>3x</strong><span>faster refill</span></li>
            <li><strong>98%</strong><span>availability</span></li>
          </ul>
        </div>
        <div class="slide-visual">
          <img src="assets/retail-hero-3.svg" alt="Retail restock and inventory monitoring" />
          <div class="visual-card">
            <span>Stock alert</span>
            <strong>${alerts.length} item(s) low</strong>
            <small>Restock due soon</small>
          </div>
        </div>
      </div>

      <div class="slider-nav">
        <button class="slider-dot active" data-slide="0" aria-label="Slide 1"></button>
        <button class="slider-dot" data-slide="1" aria-label="Slide 2"></button>
        <button class="slider-dot" data-slide="2" aria-label="Slide 3"></button>
      </div>
    </div>
    <div class="notice">
      Live store operations dashboard connected to the local backend.
    </div>
    <div class="metrics">
      ${metric("Low-stock products", alerts.length, "Live shelf counts")}
      ${metric("Queue size", queue, "Current customers")}
      ${metric("Open tasks", openTasks, "Staff actions")}
      ${metric("Staff on shift", staff.filter(p => p.checkedIn).length, "Live attendance")}
    </div>
    <div class="panels">
      ${panel("Shelf attention",
        alerts.length
          ? alerts.map(p => `<div class="alert">
              <div><strong>${p.name}</strong><small>${p.shelf} · ${p.quantity} units left</small></div>
              <span class="badge">${productStatus(p)}</span>
            </div>`).join("")
          : `<div class="alert">No low-stock alerts right now. All shelves healthy.</div>`
      )}
      ${panel("Device connections", `
        <div class="alert">Webcam <span>${connectionState.webcam}</span></div>
        <div class="alert">Local AI <span>${connectionState.ai}</span></div>
        <div class="alert">Queue AI Cam <span>${queueWebcamConnected ? "Cam 2 Online" : "Ready"}</span></div>
        <div class="alert">2 × 5 kg load cells <span>Active (Simulated & Calibrated)</span></div>
      `)}
    </div>`;
}

function refreshInventoryTableAndMetrics() {
  const tbody = document.querySelector(".inventory-split-layout table tbody");
  if (tbody) {
    tbody.innerHTML = products.map((p, i) => `<tr>
      <td><strong>${p.name}</strong><small>${p.shelf} · Load cell ${p.cell}</small></td>
      <td>${p.weight} g${p.name === "Dhal" ? " approx." : ""}</td>
      <td>${p.quantity} / ${p.maximum}</td>
      <td><span class="badge ${productStatus(p) === "Available" ? "good" : ""}">${productStatus(p)}</span></td>
      <td><div class="actions">
        <button data-action="take" data-index="${i}" ${p.quantity === 0 ? "disabled" : ""}>Take 1</button>
        <button data-action="return" data-index="${i}" ${p.quantity === p.maximum ? "disabled" : ""}>Return 1</button>
        <button class="primary" data-action="product-task" data-index="${i}"
          ${hasOpenTaskForProduct(p) ? "disabled" : ""}>
          ${hasOpenTaskForProduct(p) ? "Task already open" : "Create task"}
        </button>
      </div></td>
    </tr>`).join("");
  }

  const metricsRow = document.querySelector("main .metrics");
  if (metricsRow && currentPage === "inventory") {
    metricsRow.innerHTML = `
      ${metric("Load cell 1", (shelfWeight(1) / 1000).toFixed(3) + " kg", "Jinthaaa + Dhal")}
      ${metric("Load cell 2", (shelfWeight(2) / 1000).toFixed(3) + " kg", "Water bottle + Lifebuoy")}
      ${metric("Products", products.length, "Two per load cell")}
      ${metric("Low-stock limit", lowStockLimit, "Units or fewer")}
    `;
  }
}

function inventoryPage() {
  return heading("Shelf & Inventory", "Real-time AI camera vision and smart shelf inventory tracking") +
    `<div class="notice">
      Real-time Optical AI shelf vision synced with backend YOLOv8 object detection model and database.
    </div>
    <div class="metrics">
      ${metric("Load cell 1", (shelfWeight(1) / 1000).toFixed(3) + " kg", "Jinthaaa + Dhal")}
      ${metric("Load cell 2", (shelfWeight(2) / 1000).toFixed(3) + " kg", "Water bottle + Lifebuoy")}
      ${metric("Products", products.length, "Two per load cell")}
      ${metric("Low-stock limit", lowStockLimit, "Units or fewer")}
    </div>
    <div class="inventory-split-layout">
      ${panel("Product availability", `
        <div class="table-container">
          <table>
            <thead>
              <tr>
                <th>Product</th><th>Unit weight</th><th>Count</th>
                <th>Status</th><th>Actions</th>
              </tr>
            </thead>
            <tbody>
              ${products.map((p, i) => `<tr>
                <td><strong>${p.name}</strong><small>${p.shelf} · Load cell ${p.cell}</small></td>
                <td>${p.weight} g${p.name === "Dhal" ? " approx." : ""}</td>
                <td>${p.quantity} / ${p.maximum}</td>
                <td><span class="badge ${productStatus(p) === "Available" ? "good" : ""}">${productStatus(p)}</span></td>
                <td><div class="actions">
                  <button data-action="take" data-index="${i}" ${p.quantity === 0 ? "disabled" : ""}>Take 1</button>
                  <button data-action="return" data-index="${i}" ${p.quantity === p.maximum ? "disabled" : ""}>Return 1</button>
                  <button class="primary" data-action="product-task" data-index="${i}"
                    ${hasOpenTaskForProduct(p) ? "disabled" : ""}>
                    ${hasOpenTaskForProduct(p) ? "Task already open" : "Create task"}
                  </button>
                </div></td>
              </tr>`).join("")}
            </tbody>
          </table>
        </div>
      `)}
      ${panel("Live Shelf AI Vision Monitor (Cam 1)", `
        <div class="panel-content camera-monitor-container">
          <div class="camera-header-bar">
            <div class="camera-source-tabs">
              <button class="cam-tab-btn ${selectedCameraMode === "webcam" ? "active" : ""}" data-cam-mode="webcam" id="btn-mode-webcam">
                <span>📹</span> Browser Webcam
              </button>
              <button class="cam-tab-btn ${selectedCameraMode === "backend" ? "active" : ""}" data-cam-mode="backend" id="btn-mode-backend">
                <span>⚡</span> AI Backend Stream
              </button>
            </div>
            <div class="camera-status-pill">
              <span class="pulse-dot"></span>
              <span id="camera-stream-badge">${webcamConnected ? "LIVE STREAM" : "CAMERA READY"}</span>
            </div>
          </div>

          <div class="camera-viewport-frame" id="camera-viewport-container">
            <video id="inventory-video" autoplay muted playsinline></video>
            <img id="inventory-backend-feed" alt="Live backend camera feed" crossorigin="anonymous" />
            <canvas id="inventory-detection-overlay" aria-hidden="true"></canvas>

            <div class="camera-hud-top">
              <span class="hud-tag" id="hud-res-tag">HD 720p</span>
              <span class="hud-tag" id="hud-model-tag">YOLOv8 ByteTrack</span>
              <span class="hud-tag live-badge" id="hud-live-tag">${webcamConnected ? "ONLINE" : "STANDBY"}</span>
            </div>

            <div class="camera-hud-corners">
              <div class="hud-corner top-left"></div>
              <div class="hud-corner top-right"></div>
              <div class="hud-corner bottom-left"></div>
              <div class="hud-corner bottom-right"></div>
            </div>

            <div class="scanner-laser-line" id="scanner-laser"></div>
          </div>

          <div class="camera-detection-summary" id="camera-detection-summary">
            <div class="summary-label">AI Detected Shelf Objects:</div>
            <div class="detected-tags-list" id="detected-tags-container">
              ${lastDetectedItems.length
                ? lastDetectedItems.map(item => `
                    <span class="detected-tag">
                      ${item.name} <span class="detected-tag-count">x${item.count}</span>
                    </span>`).join("")
                : `<span class="empty-detect-notice">Ready for scan. Click 'Scan &amp; Detect' or leave Auto-Scan active.</span>`
              }
            </div>
          </div>

          <div class="camera-actions-bar">
            <button class="primary btn-start-cam" data-action="start-inventory-camera">
              ▶ Start Camera
            </button>
            <button class="btn-detect-cam" data-action="detect-shelf">
              🔍 Scan &amp; Detect Shelf
            </button>
            <button class="btn-auto-cam ${autoDetectEnabled ? "active" : ""}" data-action="toggle-auto-detect" id="btn-auto-detect">
              ⏱ Auto-Scan: ${autoDetectEnabled ? "ON (4s)" : "OFF"}
            </button>
            <button class="btn-stop-cam" data-action="stop-inventory-camera">
              ⏹ Stop
            </button>
          </div>

          <p id="inventory-camera-status" class="small-note camera-status-msg">
            Camera ready. Click 'Start Camera' to initiate the live shelf optical scanner.
          </p>
        </div>
      `)}
    </div>`;
}

function refreshQueueViewAndMetrics() {
  const waitTime = ((queue * averageServiceTime) / 60).toFixed(1);
  const metricsRow = document.querySelector("main .metrics");
  if (metricsRow && currentPage === "queue") {
    metricsRow.innerHTML = `
      ${metric("People waiting", queue, "Current queue")}
      ${metric("Estimated wait", waitTime + " min", "Based on " + averageServiceTime + "s avg service")}
      ${metric("Billing completed", served, "Completed visits")}
      ${metric("Support limit", queueLimit, "People waiting")}
    `;
  }

  const queueBadge = document.getElementById("queue-threshold-badge");
  if (queueBadge) {
    queueBadge.className = `badge ${queue >= queueLimit ? "" : "good"}`;
    queueBadge.textContent = queue >= queueLimit ? "Support needed" : "Within threshold";
  }

  const queueSummaryCount = document.getElementById("queue-detected-people-count");
  if (queueSummaryCount) {
    queueSummaryCount.textContent = `${queue} People`;
  }
}

function queuePage() {
  const waitTime = ((queue * averageServiceTime) / 60).toFixed(1);
  return heading("Queue Intelligence", "AI-Powered Customer Flow and Live Queue Camera Monitoring") +
    `<div class="notice">
      Live Cam 2 monitors the customer queue using YOLOv8 AI People Tracking and synchronizes counts to backend in real time.
    </div>
    <div class="metrics">
      ${metric("People waiting", queue, "Current queue")}
      ${metric("Estimated wait", waitTime + " min", "Based on " + averageServiceTime + "s avg service")}
      ${metric("Billing completed", served, "Completed visits")}
      ${metric("Support limit", queueLimit, "People waiting")}
    </div>
    <div class="queue-split-layout">
      ${panel("Checkout Station 01", `
        <div class="panel-content">
          <p><span id="queue-threshold-badge" class="badge ${queue >= queueLimit ? "" : "good"}">${queue >= queueLimit ? "Support needed" : "Within threshold"}</span></p>
          <p class="small-note">Queue values are dynamically updated via Cam 2 AI detection &amp; cashier events.</p>
          <div class="actions" style="margin-bottom: 16px;">
            <button data-action="arrive">+ Customer arrives</button>
            <button data-action="bill" ${queue === 0 ? "disabled" : ""}>Complete billing</button>
            <button class="primary" data-action="queue-task">Request staff assistance</button>
          </div>
          <div style="background:#faf8fc; border:1px solid #eeeaf2; border-radius:8px; padding:12px;">
            <div style="font-weight:700; font-size:12px; margin-bottom:6px; color:var(--purple);">QUEUE LINE STATUS:</div>
            <div style="font-size:13px; color:var(--muted);">${queue > 0 ? `🟢 ${queue} customer(s) currently waiting. Next service in ~${(averageServiceTime/60).toFixed(1)} min.` : "⚪ Queue is currently clear."}</div>
          </div>
        </div>
      `)}
      ${panel("Live Queue Monitor (Cam 2)", `
        <div class="panel-content camera-monitor-container">
          <div class="camera-header-bar">
            <div class="camera-source-tabs">
              <button class="cam-tab-btn ${queueSelectedCameraMode === "webcam" ? "active" : ""}" data-queue-cam-mode="webcam" id="btn-queue-mode-webcam">
                <span>📹</span> Cam 2 (Webcam / USB)
              </button>
              <button class="cam-tab-btn ${queueSelectedCameraMode === "backend" ? "active" : ""}" data-queue-cam-mode="backend" id="btn-queue-mode-backend">
                <span>⚡</span> Cam 2 (AI Stream)
              </button>
            </div>
            <div class="camera-status-pill">
              <span class="pulse-dot"></span>
              <span id="queue-stream-badge">${queueWebcamConnected ? "QUEUE CAM LIVE" : "CAM 2 READY"}</span>
            </div>
          </div>

          <div class="camera-viewport-frame" id="queue-viewport-container">
            <video id="queue-video" autoplay muted playsinline></video>
            <img id="queue-backend-feed" alt="Live Queue Camera Feed" crossorigin="anonymous" />
            <canvas id="queue-detection-overlay" aria-hidden="true"></canvas>

            <div class="camera-hud-top">
              <span class="hud-tag" id="queue-hud-res-tag">CAM 02 - QUEUE</span>
              <span class="hud-tag" id="queue-hud-model-tag">YOLOv8 Person AI</span>
              <span class="hud-tag live-badge" id="queue-hud-live-tag">${queueWebcamConnected ? "ONLINE" : "STANDBY"}</span>
            </div>

            <div class="camera-hud-corners">
              <div class="hud-corner top-left"></div>
              <div class="hud-corner top-right"></div>
              <div class="hud-corner bottom-left"></div>
              <div class="hud-corner bottom-right"></div>
            </div>

            <div class="scanner-laser-line" id="queue-scanner-laser"></div>
          </div>

          <div class="camera-detection-summary" id="queue-detection-summary">
            <div class="summary-label">AI Queue People Sensed:</div>
            <div class="detected-tags-list" id="queue-detected-tags-container">
              <span class="detected-tag">
                👥 Waiting in Queue: <strong id="queue-detected-people-count" class="detected-tag-count" style="margin-left:4px; font-size:12px;">${queue} People</strong>
              </span>
              ${queue >= queueLimit ? `<span class="badge" style="background:#fee2e2; color:#b91c1c;">⚠️ Support Alert Triggered</span>` : `<span class="badge good">Normal Traffic</span>`}
            </div>
          </div>

          <div class="camera-actions-bar">
            <button class="primary btn-start-cam" data-action="start-queue-camera">
              ▶ Start Queue Cam
            </button>
            <button class="btn-detect-cam" data-action="detect-queue">
              🔍 Scan &amp; Count People
            </button>
            <button class="btn-auto-cam ${queueAutoDetectEnabled ? "active" : ""}" data-action="toggle-queue-auto-detect" id="btn-queue-auto-detect">
              ⏱ Auto-Scan: ${queueAutoDetectEnabled ? "ON (3s)" : "OFF"}
            </button>
            <button class="btn-stop-cam" data-action="stop-queue-camera">
              ⏹ Stop Cam
            </button>
          </div>

          <p id="queue-camera-status" class="small-note camera-status-msg">
            Cam 2 ready. Point this camera at the checkout line to sense waiting customers.
          </p>
        </div>
      `)}
    </div>`;
}

function staffPage() {
  return heading("Staff & Tasks", "QR check-in and fair task assignment") +
    `<div class="notice">
      Staff check-in is synced to the live backend.
    </div>

    ${panel("Staff QR check-in", `
      <div class="panel-content">
        <div class="form-row">
          <label for="checkin-section">Select section:</label>
          <select id="checkin-section">
            ${sections.map(section => `<option value="${section}">${section}</option>`).join("")}
          </select>
          <button class="primary" data-action="start-scan">Start camera scan</button>
          <button data-action="stop-scan">Stop camera</button>
        </div>

        <video id="qr-video" autoplay muted playsinline></video>
        <p id="scan-message" class="small-note">
          Select a section and scan the staff member's QR code to check in.
        </p>

        <div class="qr-grid">
          ${staff.map((person, i) => `<div class="qr-card">
            <img class="qr-image" id="qr-${person.id}"
              src="${API_BASE}/staff/${person.id}/qr"
              alt="QR code for ${person.name}" />
            <strong>${person.name}</strong>
            <button data-action="demo-checkin" data-index="${i}">${person.checkedIn ? "Check in again" : "Check in"}</button>
          </div>`).join("")}
        </div>

        <p class="small-note">
          Print a QR code or show it on another screen to scan it.
          Use Check in button if camera scanning is unavailable.
        </p>
      </div>
    `)}

    ${panel("Team attendance", `
      <div class="table-container"><table>
        <thead><tr>
          <th>Staff member</th><th>Last section</th>
          <th>Status</th><th>Action</th>
        </tr></thead>
        <tbody>
          ${staff.map((person, i) => `<tr>
            <td><strong>${person.name}</strong>
              <small>${openTaskCount(person.name)} unfinished task(s)</small></td>
            <td>${person.section}</td>
            <td><span class="badge ${person.checkedIn ? "good" : ""}">${person.checkedIn ? "Checked in" : "Off shift"}</span></td>
            <td><button data-action="toggle" data-index="${i}">
              ${person.checkedIn ? "Check out" : "Check in"}
            </button></td>
          </tr>`).join("")}
        </tbody>
      </table></div>
    `)}

    ${panel("Task board", `
      <div class="table-container"><table>
        <thead><tr>
          <th>Task</th><th>Assigned to</th><th>Status</th><th>Action</th>
        </tr></thead>
        <tbody>
          ${tasks.length
            ? tasks.map((task, i) => `<tr>
                <td>${task.title}</td>
                <td>${task.assignedTo || "Unassigned"}</td>
                <td><span class="badge ${task.status === "Completed" ? "good" : ""}">${task.status}</span></td>
                <td>${task.status === "Completed"
                  ? "Done"
                  : `<button data-action="advance" data-index="${i}">
                      ${task.status === "Unassigned" ? "Assign staff" : "Mark completed"}
                    </button>`}
                </td>
              </tr>`).join("")
            : `<tr><td colspan="4">No tasks yet. Create one from Inventory or Queue.</td></tr>`}
        </tbody>
      </table></div>
    `)}`;
}

function renderLiveReportData() {
  const target = document.getElementById("report-live-data");
  if (!target) return;

  target.innerHTML = `
    <div class="metrics">
      ${metric("Products", products.length, "Live catalog")}
      ${metric("Units in stock", products.reduce((sum, product) => sum + product.quantity, 0), "Database quantity")}
      ${metric("Low-stock items", products.filter(product => product.quantity <= lowStockLimit).length, "Needs attention")}
      ${metric("Open tasks", tasks.filter(task => task.status !== "Completed").length, "Current assignments")}
    </div>
    <div class="table-container"><table>
      <thead><tr><th>Product</th><th>Quantity</th><th>Maximum</th><th>Status</th><th>Load cell</th></tr></thead>
      <tbody>
        ${products.map(product => `<tr>
          <td><strong>${product.name}</strong><small>${product.shelf}</small></td>
          <td>${product.quantity}</td>
          <td>${product.maximum}</td>
          <td><span class="badge ${productStatus(product) === "Available" ? "good" : ""}">${productStatus(product)}</span></td>
          <td>Cell ${product.cell}</td>
        </tr>`).join("")}
      </tbody>
    </table></div>`;
}

function startReportAutoRefresh() {
  renderLiveReportData();
  if (reportRefreshTimer) return;

  reportRefreshTimer = setInterval(async () => {
    if (currentPage !== "reports") return;
    await hydrateFromBackend();
    renderLiveReportData();
  }, 10000);
}

function reportsPage() {
  return heading("Reports", "Live inventory and operations data") +
    `<div class="notice">This report refreshes automatically from the local backend database.</div>
    ${panel("Live report", `<div id="report-live-data" class="panel-content"></div>`)}
    ${panel("Export", `
      <div class="panel-content">
        <button class="primary" data-action="export">Download current CSV</button>
      </div>
    `)}`;
}

function settingsPage() {
  return heading("Settings & Devices", "Set live alert thresholds") +
    panel("System settings", `
      <form id="settings-form" class="panel-content">
        <p><label for="stock-limit">Low stock at or below (units):</label>
          <input type="number" id="stock-limit" min="0" max="20"
            value="${lowStockLimit}" required></p>
        <p><label for="queue-limit">Queue support trigger (people):</label>
          <input type="number" id="queue-limit" min="1" max="50"
            value="${queueLimit}" required></p>
        <p><label for="service-time">Average service time (seconds):</label>
          <input type="number" id="service-time" min="10" max="600"
            value="${averageServiceTime}" required></p>
        <button class="primary" type="submit">Save settings</button>
      </form>
    `);
}

const dwellSections = ["Grocery", "Drinks", "Personal care", "Checkout"];
const dwellStorageKey = "smartmart360-dwell-live";
const automaticDwellPages = {
  inventory: "Grocery",
  queue: "Checkout",
  staff: "Personal care"
};

let dwellData;
try {
  dwellData = JSON.parse(localStorage.getItem(dwellStorageKey)) || {};
} catch (error) {
  dwellData = {};
}

for (const section of dwellSections) {
  if (!dwellData[section] || typeof dwellData[section].totalSeconds !== "number") {
    dwellData[section] = { totalSeconds: 0, visits: 0 };
  }
}

let activeDwell = null;

function saveDwell() {
  try {
    localStorage.setItem(dwellStorageKey, JSON.stringify(dwellData));
  } catch (e) {
    console.warn("Could not save dwell state.", e);
  }
}

function formatDwell(seconds) {
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${String(remainingSeconds).padStart(2, "0")}s`;
}

function finishAutomaticDwell() {
  if (!activeDwell) return;

  const elapsedSeconds = Math.max(
    1,
    Math.round((Date.now() - activeDwell.startedAt) / 1000)
  );
  if (dwellData[activeDwell.section]) {
    dwellData[activeDwell.section].totalSeconds += elapsedSeconds;
    dwellData[activeDwell.section].visits += 1;
  }
  activeDwell = null;
  saveDwell();
}

function updateAutomaticDwell(page) {
  const nextSection = automaticDwellPages[page] || null;
  if (activeDwell?.section === nextSection) return;

  finishAutomaticDwell();
  if (nextSection) {
    activeDwell = { section: nextSection, startedAt: Date.now() };
  }
}

function analyticsPage() {
  const totalVisits = dwellSections.reduce(
    (sum, section) => sum + dwellData[section].visits, 0
  );

  const totalSeconds = dwellSections.reduce(
    (sum, section) => sum + dwellData[section].totalSeconds, 0
  );

  const averageSeconds = totalVisits
    ? Math.round(totalSeconds / totalVisits)
    : 0;

  return heading(
    "Shopper Analytics",
    "Automatic activity and dwell-time signals by store section"
  ) + `
    <div class="notice">
      Dwell tracking updates automatically while live store sections are active.
    </div>

    <div class="metrics">
      ${metric("Tracked sessions", totalVisits, "Automatic section sessions")}
      ${metric("Average dwell", formatDwell(averageSeconds), "Across completed visits")}
      ${metric("Total dwell", formatDwell(totalSeconds), "Across all sections")}
      ${metric("Active section", activeDwell ? activeDwell.section : "None", "Current timer")}
    </div>

    ${panel("Dwell time by section", `
      <div class="table-container">
        <table>
          <thead>
            <tr>
              <th>Section</th>
              <th>Visits</th>
              <th>Average dwell</th>
              <th>Total dwell</th>
              <th>Timer</th>
            </tr>
          </thead>
          <tbody>
            ${dwellSections.map(section => {
              const record = dwellData[section];
              const average = record.visits
                ? Math.round(record.totalSeconds / record.visits)
                : 0;
              const isActive = activeDwell?.section === section;

              return `
                <tr>
                  <td><strong>${section}</strong></td>
                  <td>${record.visits}</td>
                  <td>${formatDwell(average)}</td>
                  <td>${formatDwell(record.totalSeconds)}</td>
                  <td>
                    ${isActive
                      ? `<strong id="live-dwell">0m 00s</strong>`
                      : `<span class="badge">Automatic</span>`}
                  </td>
                </tr>
              `;
            }).join("")}
          </tbody>
        </table>
      </div>
    `)}
  `;
}

const pages = {
  overview: ["Overview", overviewPage],
  inventory: ["Shelf & Inventory", inventoryPage],
  queue: ["Queue Intelligence", queuePage],
  staff: ["Staff & Tasks", staffPage],
  analytics: ["Shopper Analytics", analyticsPage],
  reports: ["Reports", reportsPage],
  settings: ["Settings & Devices", settingsPage]
};

// -------------------------------------------------------------
// CAM 1: INVENTORY CAMERA FUNCTIONS
// -------------------------------------------------------------

function stopAutoShelfDetection() {
  if (autoShelfDetectionTimer) {
    clearInterval(autoShelfDetectionTimer);
    autoShelfDetectionTimer = null;
  }
  autoShelfDetectionBusy = false;
}

function startAutoShelfDetection() {
  if (autoShelfDetectionTimer || currentPage !== "inventory" || !autoDetectEnabled) return;

  autoShelfDetectionTimer = setInterval(async () => {
    if (currentPage !== "inventory" || (!inventoryCameraStream && !backendCameraActive) || autoShelfDetectionBusy || !autoDetectEnabled) return;

    autoShelfDetectionBusy = true;
    try {
      await detectShelfFromCamera();
    } catch (error) {
      console.warn("Automatic shelf detection failed.", error);
    } finally {
      autoShelfDetectionBusy = false;
    }
  }, 4000);
}

function clearInventoryOverlay() {
  const overlay = document.getElementById("inventory-detection-overlay");
  if (!overlay) return;
  const context = overlay.getContext("2d");
  context.clearRect(0, 0, overlay.width, overlay.height);
}

function drawInventoryDetectionOverlay(detections) {
  const video = document.getElementById("inventory-video");
  const backendFeed = document.getElementById("inventory-backend-feed");
  const overlay = document.getElementById("inventory-detection-overlay");
  if ((!video && !backendFeed) || !overlay) return;

  const width = backendCameraActive
    ? (backendFeed?.naturalWidth || 640)
    : (video?.videoWidth || 640);
  const height = backendCameraActive
    ? (backendFeed?.naturalHeight || 480)
    : (video?.videoHeight || 480);

  if (overlay.width !== width) overlay.width = width;
  if (overlay.height !== height) overlay.height = height;

  const context = overlay.getContext("2d");
  context.clearRect(0, 0, width, height);

  const items = Array.isArray(detections) ? detections : [];
  if (!items.length) return;

  context.font = "bold 15px 'Plus Jakarta Sans', 'Segoe UI', sans-serif";
  context.textBaseline = "middle";
  let y = 30;

  items.forEach((item) => {
    const name = String(item.name || item.product || "Item");
    const count = Number(item.count ?? item.quantity ?? 1);
    const label = `✔ ${name} [${count} unit${count > 1 ? "s" : ""}]`;
    const labelWidth = context.measureText(label).width + 24;
    const labelHeight = 30;

    context.fillStyle = "rgba(17, 24, 39, 0.85)";
    context.fillRect(16, y - 15, labelWidth, labelHeight);
    context.strokeStyle = "#34d399";
    context.lineWidth = 2;
    context.strokeRect(16, y - 15, labelWidth, labelHeight);

    context.fillStyle = "#34d399";
    context.fillText(label, 26, y);
    y += 38;
  });
}

function stopInventoryCamera() {
  stopAutoShelfDetection();
  webcamConnected = false;
  clearInventoryOverlay();

  if (inventoryCameraStream) {
    inventoryCameraStream.getTracks().forEach(track => track.stop());
    inventoryCameraStream = null;
  }

  backendCameraActive = false;
  const backendFeed = document.getElementById("inventory-backend-feed");
  if (backendFeed) {
    backendFeed.src = "";
    backendFeed.classList.remove("active");
  }

  const video = document.getElementById("inventory-video");
  if (video) {
    video.pause();
    video.srcObject = null;
    video.style.display = "block";
  }

  const status = document.getElementById("inventory-camera-status");
  if (status) status.textContent = "Camera stopped.";

  const badge = document.getElementById("camera-stream-badge");
  if (badge) badge.textContent = "STANDBY";
  const liveTag = document.getElementById("hud-live-tag");
  if (liveTag) liveTag.textContent = "STANDBY";
}

function startBackendCameraFeed(feed, status) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      feed.onload = null;
      feed.onerror = null;
      feed.src = "";
      reject(new Error("Backend camera stream connection timed out."));
    }, 5000);

    feed.onload = () => {
      clearTimeout(timeout);
      feed.onload = null;
      feed.onerror = null;
      feed.classList.add("active");
      const video = document.getElementById("inventory-video");
      if (video) video.style.display = "none";
      backendCameraActive = true;
      webcamConnected = true;
      aiVisionConnected = true;

      const badge = document.getElementById("camera-stream-badge");
      if (badge) badge.textContent = "LIVE BACKEND STREAM";
      const liveTag = document.getElementById("hud-live-tag");
      if (liveTag) liveTag.textContent = "ONLINE";

      if (status) status.textContent = "Connected to live AI Backend Camera stream (OpenCV DirectShow).";
      resolve();
    };
    feed.onerror = () => {
      clearTimeout(timeout);
      feed.onload = null;
      feed.onerror = null;
      reject(new Error("Backend camera stream failed. Ensure camera is connected."));
    };
    feed.src = `${API_BASE}/camera/stream?ts=${Date.now()}`;
  });
}

async function startInventoryCamera() {
  const video = document.getElementById("inventory-video");
  const backendFeed = document.getElementById("inventory-backend-feed");
  const status = document.getElementById("inventory-camera-status");

  if (!video || !status) return;

  if (selectedCameraMode === "backend") {
    if (inventoryCameraStream) {
      inventoryCameraStream.getTracks().forEach(track => track.stop());
      inventoryCameraStream = null;
    }
    if (backendFeed) {
      try {
        status.textContent = "Connecting to backend camera stream...";
        await startBackendCameraFeed(backendFeed, status);
        if (autoDetectEnabled) startAutoShelfDetection();
        return;
      } catch (backendError) {
        console.warn("Backend camera failed:", backendError);
        status.textContent = `Backend stream error: ${backendError.message}. Try 'Browser Webcam' mode.`;
        webcamConnected = false;
        return;
      }
    }
  }

  // Browser Webcam Mode
  if (backendCameraActive && backendFeed) {
    backendFeed.src = "";
    backendFeed.classList.remove("active");
    backendCameraActive = false;
  }
  if (video) video.style.display = "block";

  if (inventoryCameraStream) {
    const activeTrack = inventoryCameraStream.getVideoTracks().find(track => track.readyState === "live");
    if (activeTrack) {
      video.srcObject = inventoryCameraStream;
      video.muted = true;
      video.playsInline = true;
      try {
        await video.play();
        webcamConnected = true;
        status.textContent = "Live webcam connected. Optical AI scanner active.";
        const badge = document.getElementById("camera-stream-badge");
        if (badge) badge.textContent = "LIVE WEBCAM";
        const liveTag = document.getElementById("hud-live-tag");
        if (liveTag) liveTag.textContent = "ONLINE";
        if (autoDetectEnabled) startAutoShelfDetection();
        return;
      } catch (e) {
        console.warn("Camera play failed, reacquiring...", e);
      }
    }
    inventoryCameraStream = null;
  }

  if (navigator.mediaDevices?.getUserMedia) {
    try {
      status.textContent = "Requesting webcam access...";
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
        audio: false
      });
      inventoryCameraStream = stream;
      video.srcObject = stream;
      video.muted = true;
      video.playsInline = true;
      await video.play();
      webcamConnected = true;
      status.textContent = "Live webcam optical scanner connected. YOLOv8 ready.";
      const badge = document.getElementById("camera-stream-badge");
      if (badge) badge.textContent = "LIVE WEBCAM";
      const liveTag = document.getElementById("hud-live-tag");
      if (liveTag) liveTag.textContent = "ONLINE";
      if (autoDetectEnabled) startAutoShelfDetection();
      return;
    } catch (browserError) {
      console.info("Client webcam not accessible, trying backend stream...", browserError);
    }
  }

  if (backendFeed) {
    try {
      status.textContent = "Webcam not available, falling back to backend stream...";
      await startBackendCameraFeed(backendFeed, status);
      selectedCameraMode = "backend";
      updateCameraTabsUI();
      if (autoDetectEnabled) startAutoShelfDetection();
      return;
    } catch (backendError) {
      console.warn("Backend camera stream unavailable:", backendError);
    }
  }

  webcamConnected = false;
  status.textContent = "Camera not detected. Check browser camera permissions or connect a USB webcam.";
}

function updateCameraTabsUI() {
  const btnWebcam = document.getElementById("btn-mode-webcam");
  const btnBackend = document.getElementById("btn-mode-backend");
  if (btnWebcam) btnWebcam.classList.toggle("active", selectedCameraMode === "webcam");
  if (btnBackend) btnBackend.classList.toggle("active", selectedCameraMode === "backend");
}

async function detectShelfFromCamera() {
  const video = document.getElementById("inventory-video");
  const backendFeed = document.getElementById("inventory-backend-feed");
  const status = document.getElementById("inventory-camera-status");
  const laser = document.getElementById("scanner-laser");
  const detectedContainer = document.getElementById("detected-tags-container");

  if ((!video && !backendFeed) || !status) return;

  if (!inventoryCameraStream && !backendCameraActive) {
    await startInventoryCamera();
  }

  const feed = backendCameraActive ? backendFeed : video;
  const feedWidth = backendCameraActive ? (feed?.naturalWidth || 640) : (feed?.videoWidth || 640);
  const feedHeight = backendCameraActive ? (feed?.naturalHeight || 480) : (feed?.videoHeight || 480);

  if (!feed || !feedWidth || !feedHeight) {
    status.textContent = "Start the camera before scanning.";
    return;
  }

  try {
    if (laser) laser.classList.add("scanning");
    const canvas = inventoryCaptureCanvas || (inventoryCaptureCanvas = document.createElement("canvas"));
    const captureScale = Math.min(1, 960 / feedWidth);
    canvas.width = Math.max(1, Math.round(feedWidth * captureScale));
    canvas.height = Math.max(1, Math.round(feedHeight * captureScale));
    const context = canvas.getContext("2d");
    context.drawImage(feed, 0, 0, canvas.width, canvas.height);
    const imageData = canvas.toDataURL("image/jpeg", 0.75);

    status.textContent = "Analyzing shelf with YOLOv8 & ByteTrack AI...";
    const response = await fetch(`${API_BASE}/shelf/detect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: imageData })
    });

    if (!response.ok) {
      throw new Error(`Detection request failed: ${response.status}`);
    }

    const payload = await response.json();
    const detections = Array.isArray(payload?.data) ? payload.data : [];
    lastDetectedItems = detections;
    aiVisionConnected = true;
    drawInventoryDetectionOverlay(detections);

    for (const item of detections) {
      const matched = products.find(product => product.name.toLowerCase() === String(item.name || "").toLowerCase());
      if (!matched) continue;

      const target = Math.max(0, Number(item.count ?? matched.quantity));
      const delta = target - matched.quantity;
      if (delta !== 0) {
        await apiRequest(`/products/${matched.id}/adjust`, {
          method: "POST",
          body: JSON.stringify({ delta })
        });
        matched.quantity = target;
      }
    }

    persistLocalState();
    completeRestockTasksForFullStock();
    refreshInventoryTableAndMetrics();

    if (detectedContainer) {
      if (detections.length > 0) {
        detectedContainer.innerHTML = detections.map(d => `
          <span class="detected-tag">
            ${d.name} <span class="detected-tag-count">x${d.count}</span>
          </span>`).join("");
      } else {
        detectedContainer.innerHTML = `<span class="empty-detect-notice">Frame analyzed. No objects matched store inventory.</span>`;
      }
    }

    if (detections.length > 0) {
      const detectedSummary = detections.map(d => `${d.name} (x${d.count})`).join(", ");
      status.textContent = `AI detection complete: [${detectedSummary}]. Synced with database.`;
    } else {
      status.textContent = "Shelf frame scanned. Inventory records up to date.";
    }
  } catch (error) {
    console.warn("Shelf detection failed.", error);
    status.textContent = "Detection attempt finished. Keeping current inventory state.";
  } finally {
    if (laser) laser.classList.remove("scanning");
  }
}

// -------------------------------------------------------------
// CAM 2: QUEUE INTELLIGENCE CAMERA FUNCTIONS
// -------------------------------------------------------------

function stopAutoQueueDetection() {
  if (queueAutoDetectTimer) {
    clearInterval(queueAutoDetectTimer);
    queueAutoDetectTimer = null;
  }
  queueAutoDetectBusy = false;
}

function startAutoQueueDetection() {
  if (queueAutoDetectTimer || currentPage !== "queue" || !queueAutoDetectEnabled) return;

  queueAutoDetectTimer = setInterval(async () => {
    if (currentPage !== "queue" || (!queueCameraStream && !queueBackendCameraActive) || queueAutoDetectBusy || !queueAutoDetectEnabled) return;

    queueAutoDetectBusy = true;
    try {
      await detectQueueFromCamera();
    } catch (error) {
      console.warn("Automatic queue detection failed.", error);
    } finally {
      queueAutoDetectBusy = false;
    }
  }, 3500);
}

function clearQueueOverlay() {
  const overlay = document.getElementById("queue-detection-overlay");
  if (!overlay) return;
  const context = overlay.getContext("2d");
  context.clearRect(0, 0, overlay.width, overlay.height);
}

function drawQueueDetectionOverlay(detections) {
  const video = document.getElementById("queue-video");
  const backendFeed = document.getElementById("queue-backend-feed");
  const overlay = document.getElementById("queue-detection-overlay");
  if ((!video && !backendFeed) || !overlay) return;

  const width = queueBackendCameraActive
    ? (backendFeed?.naturalWidth || 640)
    : (video?.videoWidth || 640);
  const height = queueBackendCameraActive
    ? (backendFeed?.naturalHeight || 480)
    : (video?.videoHeight || 480);

  if (overlay.width !== width) overlay.width = width;
  if (overlay.height !== height) overlay.height = height;

  const context = overlay.getContext("2d");
  context.clearRect(0, 0, width, height);

  const items = Array.isArray(detections) ? detections : [];

  // Draw overall detected count banner
  const count = items.length;
  const countLabel = `👥 Sensed in Line: ${count} Person${count === 1 ? "" : "s"}`;
  context.font = "bold 15px 'Plus Jakarta Sans', 'Segoe UI', sans-serif";
  context.textBaseline = "middle";
  const labelWidth = context.measureText(countLabel).width + 24;
  const bannerBg = count >= queueLimit ? "rgba(220, 38, 38, 0.88)" : "rgba(17, 24, 39, 0.88)";
  const bannerBorder = count >= queueLimit ? "#ef4444" : "#34d399";

  context.fillStyle = bannerBg;
  context.fillRect(16, 20, labelWidth, 32);
  context.strokeStyle = bannerBorder;
  context.lineWidth = 2;
  context.strokeRect(16, 20, labelWidth, 32);

  context.fillStyle = count >= queueLimit ? "#fecaca" : "#34d399";
  context.fillText(countLabel, 26, 36);

  // Draw bounding boxes for each person
  items.forEach((person, idx) => {
    if (Array.isArray(person.box) && person.box.length === 4) {
      const [x1, y1, x2, y2] = person.box;
      const boxW = Math.max(10, x2 - x1);
      const boxH = Math.max(10, y2 - y1);

      context.strokeStyle = "#34d399";
      context.lineWidth = 3;
      context.strokeRect(x1, y1, boxW, boxH);

      // Person Tag
      const tagText = `Person #${idx + 1} (${Math.round((person.confidence || 0.8) * 100)}%)`;
      context.font = "bold 12px sans-serif";
      const tagW = context.measureText(tagText).width + 12;
      context.fillStyle = "rgba(17, 24, 39, 0.85)";
      context.fillRect(x1, Math.max(0, y1 - 22), tagW, 20);
      context.fillStyle = "#34d399";
      context.fillText(tagText, x1 + 6, Math.max(10, y1 - 12));
    }
  });
}

function stopQueueCamera() {
  stopAutoQueueDetection();
  queueWebcamConnected = false;
  clearQueueOverlay();

  if (queueCameraStream) {
    queueCameraStream.getTracks().forEach(track => track.stop());
    queueCameraStream = null;
  }

  queueBackendCameraActive = false;
  const backendFeed = document.getElementById("queue-backend-feed");
  if (backendFeed) {
    backendFeed.src = "";
    backendFeed.classList.remove("active");
  }

  const video = document.getElementById("queue-video");
  if (video) {
    video.pause();
    video.srcObject = null;
    video.style.display = "block";
  }

  const status = document.getElementById("queue-camera-status");
  if (status) status.textContent = "Queue camera stopped.";

  const badge = document.getElementById("queue-stream-badge");
  if (badge) badge.textContent = "CAM 2 READY";
  const liveTag = document.getElementById("queue-hud-live-tag");
  if (liveTag) liveTag.textContent = "STANDBY";
}

function startQueueBackendCameraFeed(feed, status) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      feed.onload = null;
      feed.onerror = null;
      feed.src = "";
      reject(new Error("Queue backend camera connection timed out."));
    }, 5000);

    feed.onload = () => {
      clearTimeout(timeout);
      feed.onload = null;
      feed.onerror = null;
      feed.classList.add("active");
      const video = document.getElementById("queue-video");
      if (video) video.style.display = "none";
      queueBackendCameraActive = true;
      queueWebcamConnected = true;

      const badge = document.getElementById("queue-stream-badge");
      if (badge) badge.textContent = "QUEUE CAM 2 LIVE";
      const liveTag = document.getElementById("queue-hud-live-tag");
      if (liveTag) liveTag.textContent = "ONLINE";

      if (status) status.textContent = "Connected to live Queue Camera stream (OpenCV DirectShow).";
      resolve();
    };
    feed.onerror = () => {
      clearTimeout(timeout);
      feed.onload = null;
      feed.onerror = null;
      reject(new Error("Queue camera stream failed. Ensure camera is plugged in."));
    };
    feed.src = `${API_BASE}/camera/queue/stream?ts=${Date.now()}`;
  });
}

async function startQueueCamera() {
  const video = document.getElementById("queue-video");
  const backendFeed = document.getElementById("queue-backend-feed");
  const status = document.getElementById("queue-camera-status");

  if (!video || !status) return;

  if (queueSelectedCameraMode === "backend") {
    if (queueCameraStream) {
      queueCameraStream.getTracks().forEach(track => track.stop());
      queueCameraStream = null;
    }
    if (backendFeed) {
      try {
        status.textContent = "Connecting to queue camera backend stream...";
        await startQueueBackendCameraFeed(backendFeed, status);
        if (queueAutoDetectEnabled) startAutoQueueDetection();
        return;
      } catch (backendError) {
        console.warn("Queue backend camera stream error:", backendError);
        status.textContent = `Backend stream error: ${backendError.message}. Try 'Cam 2 (Webcam / USB)' mode.`;
        queueWebcamConnected = false;
        return;
      }
    }
  }

  // Browser Webcam Mode
  if (queueBackendCameraActive && backendFeed) {
    backendFeed.src = "";
    backendFeed.classList.remove("active");
    queueBackendCameraActive = false;
  }
  if (video) video.style.display = "block";

  if (queueCameraStream) {
    const activeTrack = queueCameraStream.getVideoTracks().find(track => track.readyState === "live");
    if (activeTrack) {
      video.srcObject = queueCameraStream;
      video.muted = true;
      video.playsInline = true;
      try {
        await video.play();
        queueWebcamConnected = true;
        status.textContent = "Live Queue Cam 2 connected. YOLOv8 People sensing active.";
        const badge = document.getElementById("queue-stream-badge");
        if (badge) badge.textContent = "QUEUE CAM 2 LIVE";
        const liveTag = document.getElementById("queue-hud-live-tag");
        if (liveTag) liveTag.textContent = "ONLINE";
        if (queueAutoDetectEnabled) startAutoQueueDetection();
        return;
      } catch (e) {
        console.warn("Queue camera play failed, reacquiring...", e);
      }
    }
    queueCameraStream = null;
  }

  if (navigator.mediaDevices?.getUserMedia) {
    try {
      status.textContent = "Requesting Queue camera device access...";
      const videoConstraints = {
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 30 }
      };

      // If specific device or second camera exists, select it
      if (queueSelectedDeviceId) {
        videoConstraints.deviceId = { exact: queueSelectedDeviceId };
      } else if (availableVideoDevices.length > 1) {
        // Automatically pick the second camera for Queue Monitor if available
        videoConstraints.deviceId = { exact: availableVideoDevices[1].deviceId };
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        video: videoConstraints,
        audio: false
      });
      queueCameraStream = stream;
      video.srcObject = stream;
      video.muted = true;
      video.playsInline = true;
      await video.play();
      queueWebcamConnected = true;
      status.textContent = "Live Queue Camera (Cam 2) optical people tracking connected.";
      const badge = document.getElementById("queue-stream-badge");
      if (badge) badge.textContent = "QUEUE CAM 2 LIVE";
      const liveTag = document.getElementById("queue-hud-live-tag");
      if (liveTag) liveTag.textContent = "ONLINE";
      if (queueAutoDetectEnabled) startAutoQueueDetection();
      return;
    } catch (browserError) {
      console.info("Cam 2 browser webcam not accessible, trying backend queue stream...", browserError);
    }
  }

  if (backendFeed) {
    try {
      status.textContent = "Falling back to backend queue camera stream...";
      await startQueueBackendCameraFeed(backendFeed, status);
      queueSelectedCameraMode = "backend";
      updateQueueCameraTabsUI();
      if (queueAutoDetectEnabled) startAutoQueueDetection();
      return;
    } catch (backendError) {
      console.warn("Queue backend camera stream unavailable:", backendError);
    }
  }

  queueWebcamConnected = false;
  status.textContent = "Queue camera not detected. Ensure webcam permissions are allowed or plug in USB Cam 2.";
}

function updateQueueCameraTabsUI() {
  const btnWebcam = document.getElementById("btn-queue-mode-webcam");
  const btnBackend = document.getElementById("btn-queue-mode-backend");
  if (btnWebcam) btnWebcam.classList.toggle("active", queueSelectedCameraMode === "webcam");
  if (btnBackend) btnBackend.classList.toggle("active", queueSelectedCameraMode === "backend");
}

async function detectQueueFromCamera() {
  const video = document.getElementById("queue-video");
  const backendFeed = document.getElementById("queue-backend-feed");
  const status = document.getElementById("queue-camera-status");
  const laser = document.getElementById("queue-scanner-laser");
  const countDisplay = document.getElementById("queue-detected-people-count");
  const summaryContainer = document.getElementById("queue-detected-tags-container");

  if ((!video && !backendFeed) || !status) return;

  if (!queueCameraStream && !queueBackendCameraActive) {
    await startQueueCamera();
  }

  const feed = queueBackendCameraActive ? backendFeed : video;
  const feedWidth = queueBackendCameraActive ? (feed?.naturalWidth || 640) : (feed?.videoWidth || 640);
  const feedHeight = queueBackendCameraActive ? (feed?.naturalHeight || 480) : (feed?.videoHeight || 480);

  if (!feed || !feedWidth || !feedHeight) {
    status.textContent = "Start Queue Cam before scanning.";
    return;
  }

  try {
    if (laser) laser.classList.add("scanning");
    const canvas = queueCaptureCanvas || (queueCaptureCanvas = document.createElement("canvas"));
    const captureScale = Math.min(1, 960 / feedWidth);
    canvas.width = Math.max(1, Math.round(feedWidth * captureScale));
    canvas.height = Math.max(1, Math.round(feedHeight * captureScale));
    const context = canvas.getContext("2d");
    context.drawImage(feed, 0, 0, canvas.width, canvas.height);
    const imageData = canvas.toDataURL("image/jpeg", 0.75);

    status.textContent = "Sensing people with YOLOv8 People AI...";
    const response = await fetch(`${API_BASE}/queue/detect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: imageData })
    });

    if (!response.ok) {
      throw new Error(`Queue detection request failed: ${response.status}`);
    }

    const payload = await response.json();
    const data = payload?.data || {};
    const peopleCount = Number(data.people_waiting ?? data.people_count ?? queue);
    const detections = Array.isArray(data.detections) ? data.detections : [];
    lastQueueDetections = detections;

    queue = peopleCount;
    persistLocalState();
    drawQueueDetectionOverlay(detections);
    refreshQueueViewAndMetrics();

    if (summaryContainer) {
      summaryContainer.innerHTML = `
        <span class="detected-tag">
          👥 Sensed in Line: <strong class="detected-tag-count" style="margin-left:4px; font-size:12px;">${peopleCount} People</strong>
        </span>
        ${peopleCount >= queueLimit ? `<span class="badge" style="background:#fee2e2; color:#b91c1c;">⚠️ Support Alert Triggered</span>` : `<span class="badge good">Normal Traffic</span>`}
      `;
    }

    if (peopleCount >= queueLimit) {
      addTask("Checkout assistance");
    }

    status.textContent = `Queue AI Scan Complete: Sensed ${peopleCount} customer(s). Synced to live checkout records.`;
  } catch (error) {
    console.warn("Queue detection failed.", error);
    status.textContent = "Queue scan attempt finished. Keeping current count.";
  } finally {
    if (laser) laser.classList.remove("scanning");
  }
}

// -------------------------------------------------------------
// QR SCANNER FUNCTIONS
// -------------------------------------------------------------

function stopScanner() {
  if (scanFrame) cancelAnimationFrame(scanFrame);
  scanFrame = null;
  scanning = false;

  if (cameraStream) {
    cameraStream.getTracks().forEach(track => track.stop());
    cameraStream = null;
  }
}

async function startScanner() {
  stopScanner();

  const video = document.getElementById("qr-video");
  const message = document.getElementById("scan-message");

  if (!navigator.mediaDevices?.getUserMedia || !("BarcodeDetector" in window)) {
    if (message) {
      message.textContent = "Camera QR scanning is unavailable in this browser. Use the Check in button below.";
    }
    return;
  }

  try {
    const detector = new BarcodeDetector({ formats: ["qr_code"] });

    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment" },
      audio: false
    });

    if (currentPage !== "staff") {
      stopScanner();
      return;
    }

    video.srcObject = cameraStream;
    video.classList.add("active");
    await video.play();
    if (message) message.textContent = "Point the camera at a staff QR code.";

    async function scan() {
      if (!cameraStream || currentPage !== "staff") return;

      if (!scanning && video.readyState >= 2) {
        scanning = true;
        try {
          const codes = await detector.detect(video);
          if (!cameraStream) return;

          for (const code of codes) {
            const match = /^SMARTMART360-STAFF:(\d+)$/.exec(code.rawValue);
            if (match) {
              const staffIndex = staff.findIndex(person => person.id === Number(match[1]));
              if (staffIndex >= 0) {
                checkIn(staffIndex);
                return;
              }
            }
          }
        } catch (error) {
          if (message) message.textContent = "Scanning failed. Use the check-in button below.";
          stopScanner();
          return;
        } finally {
          scanning = false;
        }
      }

      scanFrame = requestAnimationFrame(scan);
    }

    scan();
  } catch (error) {
    stopScanner();
    if (message) {
      message.textContent = "Camera permission denied or no camera available. Use the check-in button below.";
    }
  }
}

function showPage(page) {
  if (!pages[page]) page = "overview";
  const animateEntry = !initialPageRendered;
  stopScanner();
  currentPage = page;
  updateAutomaticDwell(page);
  persistLocalState();

  document.getElementById("current-page").textContent = pages[page][0];
  main.innerHTML = pages[page][1]();
  main.classList.toggle("page-entry", animateEntry);
  initialPageRendered = true;

  document.querySelectorAll(".nav-button").forEach(button => {
    button.classList.toggle("active", button.dataset.page === page);
  });

  if (page === "overview") {
    startHeroSlider();
  } else if (heroSliderTimer) {
    clearInterval(heroSliderTimer);
    heroSliderTimer = null;
  }

  if (page === "staff") {
    drawQRCodes();
  }

  if (page === "inventory") {
    startInventoryCamera().then(() => {
      if (autoDetectEnabled) startAutoShelfDetection();
    }).catch(error => console.warn("Unable to start automatic inventory detection.", error));
  } else {
    stopAutoShelfDetection();
    if (inventoryCameraStream) stopInventoryCamera();
  }

  if (page === "queue") {
    startQueueCamera().then(() => {
      if (queueAutoDetectEnabled) startAutoQueueDetection();
    }).catch(error => console.warn("Unable to start queue camera.", error));
  } else {
    stopAutoQueueDetection();
    if (queueCameraStream) stopQueueCamera();
  }

  if (page === "reports") {
    startReportAutoRefresh();
  } else if (reportRefreshTimer) {
    clearInterval(reportRefreshTimer);
    reportRefreshTimer = null;
  }
}

function drawQRCodes() {
  staff.forEach(person => {
    const image = document.getElementById("qr-" + person.id);
    if (image) {
      image.src = `${API_BASE}/staff/${person.id}/qr?ts=${Date.now()}`;
    }
  });
}

function checkIn(index) {
  const section = document.getElementById("checkin-section")?.value;
  if (!staff[index] || !sections.includes(section)) return;

  const person = staff[index];
  person.section = section;
  person.checkedIn = true;
  persistLocalState();

  apiRequest(`/staff/${person.id}/check-in`, { method: "POST" })
    .catch(error => console.warn("Could not check in staff.", error));

  showPage("staff");
  const msgEl = document.getElementById("scan-message");
  if (msgEl) {
    msgEl.textContent = `${person.name} checked in to ${section}.`;
  }
}

function exportInventory() {
  const rows = [
    ["Product", "Unit Weight (g)", "Current Quantity", "Maximum Quantity", "Status", "Rack Location", "Load Cell"],
    ...products.map(p => [
      p.name,
      p.weight,
      p.quantity,
      p.maximum,
      productStatus(p),
      p.shelf,
      `Load Cell ${p.cell}`
    ])
  ];

  const csvContent = rows
    .map(row =>
      row
        .map(cell => `"${String(cell ?? "").replace(/"/g, '""')}"`)
        .join(",")
    )
    .join("\r\n");

  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `SmartMart360-inventory-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

document.getElementById("nav").addEventListener("click", event => {
  const button = event.target.closest("button[data-page]");
  if (button) showPage(button.dataset.page);
});

main.addEventListener("click", event => {
  const modeBtn = event.target.closest("button[data-cam-mode]");
  if (modeBtn) {
    selectedCameraMode = modeBtn.dataset.camMode;
    updateCameraTabsUI();
    stopInventoryCamera();
    startInventoryCamera();
    return;
  }

  const queueModeBtn = event.target.closest("button[data-queue-cam-mode]");
  if (queueModeBtn) {
    queueSelectedCameraMode = queueModeBtn.dataset.queueCamMode;
    updateQueueCameraTabsUI();
    stopQueueCamera();
    startQueueCamera();
    return;
  }

  const button = event.target.closest("button[data-target]");
  if (button && pages[button.dataset.target]) {
    showPage(button.dataset.target);
    return;
  }

  const actionButton = event.target.closest("button[data-action]");
  if (!actionButton) return;

  const action = actionButton.dataset.action;
  const index = Number(actionButton.dataset.index);

  // Inventory Cam (Cam 1)
  if (action === "start-inventory-camera") {
    startInventoryCamera();
  } else if (action === "detect-shelf") {
    detectShelfFromCamera();
  } else if (action === "toggle-auto-detect") {
    autoDetectEnabled = !autoDetectEnabled;
    const btnAuto = document.getElementById("btn-auto-detect");
    if (btnAuto) {
      btnAuto.classList.toggle("active", autoDetectEnabled);
      btnAuto.textContent = `⏱ Auto-Scan: ${autoDetectEnabled ? "ON (4s)" : "OFF"}`;
    }
    if (autoDetectEnabled) {
      startAutoShelfDetection();
    } else {
      stopAutoShelfDetection();
    }
  } else if (action === "stop-inventory-camera") {
    stopInventoryCamera();
  }

  // Queue Cam (Cam 2)
  else if (action === "start-queue-camera") {
    startQueueCamera();
  } else if (action === "detect-queue") {
    detectQueueFromCamera();
  } else if (action === "toggle-queue-auto-detect") {
    queueAutoDetectEnabled = !queueAutoDetectEnabled;
    const btnQueueAuto = document.getElementById("btn-queue-auto-detect");
    if (btnQueueAuto) {
      btnQueueAuto.classList.toggle("active", queueAutoDetectEnabled);
      btnQueueAuto.textContent = `⏱ Auto-Scan: ${queueAutoDetectEnabled ? "ON (3s)" : "OFF"}`;
    }
    if (queueAutoDetectEnabled) {
      startAutoQueueDetection();
    } else {
      stopAutoQueueDetection();
    }
  } else if (action === "stop-queue-camera") {
    stopQueueCamera();
  }

  // Staff QR Scanner
  else if (action === "start-scan") {
    startScanner();
  } else if (action === "stop-scan") {
    stopScanner();
    document.getElementById("qr-video")?.classList.remove("active");
    const msg = document.getElementById("scan-message");
    if (msg) msg.textContent = "Camera stopped.";
  } else if (action === "demo-checkin") {
    checkIn(index);
  } else if (action === "toggle") {
    const person = staff[index];
    if (!person) return;

    const endpoint = person.checkedIn ? `/staff/${person.id}/check-out` : `/staff/${person.id}/check-in`;
    apiRequest(endpoint, { method: "POST" })
      .then(result => {
        person.checkedIn = Boolean(result?.data?.checked_in ?? !person.checkedIn);
        persistLocalState();
        showPage("staff");
      })
      .catch(error => {
        console.warn("Could not update staff status.", error);
        person.checkedIn = !person.checkedIn;
        persistLocalState();
        showPage("staff");
      });
  } else if (action === "take") {
    const product = products[index];
    if (product && product.quantity > 0) {
      const current = product.quantity;
      product.quantity--;
      persistLocalState();
      apiRequest(`/products/${product.id}/adjust`, {
        method: "POST",
        body: JSON.stringify({ delta: -1 })
      }).catch(error => {
        console.warn("Could not update product in backend.", error);
        product.quantity = current;
        persistLocalState();
      });
      if (product.quantity <= lowStockLimit) addTask("Refill " + product.name, product.id);
      showPage("inventory");
    }
  } else if (action === "return") {
    const product = products[index];
    if (product && product.quantity < product.maximum) {
      const current = product.quantity;
      product.quantity++;
      persistLocalState();
      apiRequest(`/products/${product.id}/adjust`, {
        method: "POST",
        body: JSON.stringify({ delta: 1 })
      }).catch(error => {
        console.warn("Could not restore product in backend.", error);
        product.quantity = current;
        persistLocalState();
      });
      completeRestockTasksForFullStock();
      showPage("inventory");
    }
  } else if (action === "product-task") {
    const product = products[index];
    if (product) {
      if (!addTask("Refill " + product.name, product.id)) {
        alert("An open restock task for " + product.name + " already exists.");
      }
      showPage("inventory");
    }
  } else if (action === "arrive") {
    queue++;
    persistLocalState();
    apiRequest("/queue", {
      method: "POST",
      body: JSON.stringify({
        people_waiting: queue,
        support_limit: queueLimit,
        average_service_time: averageServiceTime,
        estimated_wait: Number(((queue * averageServiceTime) / 60).toFixed(1))
      })
    }).catch(error => console.warn("Could not sync queue to backend.", error));
    if (queue >= queueLimit) addTask("Checkout assistance");
    showPage("queue");
  } else if (action === "bill") {
    if (queue > 0) {
      queue--;
      served++;
      persistLocalState();
      apiRequest("/queue", {
        method: "POST",
        body: JSON.stringify({
          people_waiting: queue,
          support_limit: queueLimit,
          average_service_time: averageServiceTime,
          estimated_wait: Number(((queue * averageServiceTime) / 60).toFixed(1))
        })
      }).catch(error => console.warn("Could not sync queue to backend.", error));
      showPage("queue");
    }
  } else if (action === "queue-task") {
    if (!addTask("Checkout assistance")) {
      alert("An open checkout assistance task already exists.");
    }
    showPage("queue");
  } else if (action === "advance") {
    const task = tasks[index];
    if (!task) return;

    if (task.status === "Unassigned") {
      const person = chooseStaff();
      if (!person) {
        alert("Please check in a staff member first before assigning tasks.");
        return;
      }

      task.assignedTo = person.name;
      task.status = "Assigned";
      persistLocalState();
      apiRequest(`/tasks/${task.id}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "ASSIGNED", staff_id: person.id })
      }).catch(error => console.warn("Could not assign task.", error));
    } else if (task.status === "Assigned") {
      task.status = "Completed";
      persistLocalState();
      apiRequest(`/tasks/${task.id}/status`, {
        method: "POST",
        body: JSON.stringify({ status: "COMPLETED" })
      }).catch(error => console.warn("Could not complete task.", error));
    }

    showPage("staff");
  } else if (action === "export") {
    exportInventory();
  }
});

main.addEventListener("submit", async event => {
  if (event.target.id !== "settings-form") return;
  event.preventDefault();

  const stock = Number(document.getElementById("stock-limit").value);
  const support = Number(document.getElementById("queue-limit").value);
  const service = Number(document.getElementById("service-time")?.value || 90);

  if (!Number.isInteger(stock) || stock < 0 || stock > 20 ||
      !Number.isInteger(support) || support < 1 || support > 50 ||
      !Number.isInteger(service) || service < 10 || service > 600) {
    alert("Please enter valid whole numbers within the allowed ranges.");
    return;
  }

  lowStockLimit = stock;
  queueLimit = support;
  averageServiceTime = service;
  persistLocalState();

  try {
    const response = await fetch(`${API_BASE}/settings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        low_stock_limit: stock,
        queue_support_limit: support,
        average_service_time: service
      })
    });

    if (!response.ok) {
      console.warn("Settings sync failed on backend.");
    }
  } catch (error) {
    console.warn("Could not sync settings to backend.", error);
  }

  alert("Settings saved successfully.");
  showPage("settings");
});

function startHeroSlider() {
  const slider = document.querySelector(".hero-slider");
  if (!slider) {
    if (heroSliderTimer) {
      clearInterval(heroSliderTimer);
      heroSliderTimer = null;
    }
    return;
  }

  const slides = slider.querySelectorAll(".slide");
  const dots = slider.querySelectorAll(".slider-dot");

  if (!slides.length) return;

  if (heroSliderTimer) {
    clearInterval(heroSliderTimer);
    heroSliderTimer = null;
  }

  function activateSlide(index) {
    heroSliderIndex = (index + slides.length) % slides.length;
    slides.forEach((slide, i) => slide.classList.toggle("active", i === heroSliderIndex));
    dots.forEach((dot, i) => dot.classList.toggle("active", i === heroSliderIndex));
  }

  activateSlide(heroSliderIndex);

  heroSliderTimer = setInterval(() => {
    activateSlide(heroSliderIndex + 1);
  }, 4500);

  dots.forEach(dot => {
    dot.onclick = (e) => {
      e.stopPropagation();
      const targetIndex = Number(dot.dataset.slide);
      activateSlide(targetIndex);
      if (heroSliderTimer) clearInterval(heroSliderTimer);
      heroSliderTimer = setInterval(() => {
        activateSlide(heroSliderIndex + 1);
      }, 4500);
    };
  });
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    finishAutomaticDwell();
    if (heroSliderTimer) {
      clearInterval(heroSliderTimer);
      heroSliderTimer = null;
    }
  } else {
    updateAutomaticDwell(currentPage);
    if (currentPage === "overview") {
      startHeroSlider();
    }
  }
});

setInterval(() => {
  if (!activeDwell || currentPage !== "analytics") return;

  const display = document.getElementById("live-dwell");
  if (!display) return;

  const elapsedSeconds = Math.floor(
    (Date.now() - activeDwell.startedAt) / 1000
  );

  display.textContent = formatDwell(elapsedSeconds);
}, 1000);

hydrateFromBackend().finally(() => {
  showPage("overview");
});