// server.js

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const YooKassa = require("yookassa");

const app = express();
const PORT = process.env.PORT || 4000;

const yooKassa = new YooKassa({
  shopId: process.env.YOOKASSA_SHOP_ID,
  secretKey: process.env.YOOKASSA_SECRET_KEY,
});

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";

// middlewares
app.use(cors());
app.use(express.json());

// ================== демо-данные ==================

const SELLERS = [
  { id: "s-01", name: "Store Matvey", city: "Москва" },
  { id: "s-02", name: "Borovsky Retail", city: "Санкт-Петербург" },
  { id: "s-03", name: "Zhuk Select", city: "Казань" },
];

const PRODUCTS = [
  {
    id: "p-01",
    title: "Aether Runner V2",
    brand: "Aether",
    price: 12990,
    category: "Кроссовки",
    sellerId: "s-01",
    colors: ["Белый", "Графит"],
    sizes: ["40", "41", "42", "43"],
    badge: "Новинка",
  },
  {
    id: "p-02",
    title: "Noir Shell Parka",
    brand: "Noir",
    price: 24990,
    category: "Куртки",
    sellerId: "s-02",
    colors: ["Чёрный"],
    sizes: ["S", "M", "L"],
    badge: "Хит",
  },
  {
    id: "p-03",
    title: "Linea Tote 24",
    brand: "Linea",
    price: 10990,
    category: "Сумки",
    sellerId: "s-03",
    colors: ["Песочный", "Олива"],
    sizes: ["OS"],
  },
  {
    id: "p-04",
    title: "Vertex Raw Denim",
    brand: "Vertex",
    price: 8990,
    category: "Джинсы",
    sellerId: "s-01",
    colors: ["Индиго"],
    sizes: ["30", "31", "32", "33"],
  },
  {
    id: "p-05",
    title: "Forma Minimal Cap",
    brand: "Forma",
    price: 2990,
    category: "Аксессуары",
    sellerId: "s-02",
    colors: ["Серый", "Синий"],
    sizes: ["OS"],
    badge: "-15%",
  },
  {
    id: "p-06",
    title: "Aether Glide",
    brand: "Aether",
    price: 11990,
    category: "Кроссовки",
    sellerId: "s-03",
    colors: ["Белый"],
    sizes: ["41", "42", "43"],
  },
];

const ORDERS = [];

// ================== утилиты ==================

function calcOrderSummary(cart) {
  const items = cart
    .map((ci) => {
      const product = PRODUCTS.find((p) => p.id === ci.id);
      if (!product) return null;
      return {
        productId: product.id,
        title: product.title,
        qty: Number(ci.qty) || 1,
        price: Number(product.price),
        sellerId: product.sellerId,
      };
    })
    .filter(Boolean);

  const total = items.reduce((sum, item) => sum + item.qty * item.price, 0);

  return { items, total };
}

function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) {
    return res.status(500).json({ error: "ADMIN_TOKEN не задан на сервере" });
  }
  const token = req.headers["x-admin-token"];
  if (!token || token !== ADMIN_TOKEN) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
}

// ================== публичные эндпоинты ==================

app.get("/api/health", (req, res) => {
  res.json({ status: "ok", service: "sello-backend" });
});

app.get("/api/products", (req, res) => {
  res.json({ products: PRODUCTS, sellers: SELLERS });
});

app.post("/api/orders", async (req, res) => {
  try {
    const { cart, customer } = req.body || {};

    if (!Array.isArray(cart) || cart.length === 0) {
      return res.status(400).json({ error: "Корзина пуста или некорректна" });
    }

    const { items, total } = calcOrderSummary(cart);

    if (!items.length) {
      return res
        .status(400)
        .json({ error: "Товары из корзины не найдены на сервере" });
    }

    const orderId = "SO-" + Math.floor(100000 + Math.random() * 900000);

    const order = {
      id: orderId,
      items,
      total,
      customer: customer || { type: "guest" },
      status: "pending",
      paymentStatus: "pending",
      createdAt: new Date().toISOString(),
    };

    ORDERS.push(order);

    const receipt = {
      customer: {
        email:
          (customer && customer.email) ||
          "test@example.com", // потом заменишь на реальный email
      },
      items: items.map((i) => ({
        description: i.title || "Товар",
        quantity: i.qty,
        amount: {
          value: i.price.toFixed(2),
          currency: "RUB",
        },
        vat_code: 1,
      })),
    };

    const payment = await yooKassa.createPayment({
      amount: {
        value: total.toFixed(2),
        currency: "RUB",
      },
      capture: true,
      confirmation: {
        type: "redirect",
        return_url: process.env.YOOKASSA_RETURN_URL,
      },
      description: `SelloMarket: заказ ${orderId}`,
      metadata: {
        orderId,
      },
      receipt,
    });

    const paymentUrl = payment.confirmation?.confirmation_url;

    if (!paymentUrl) {
      console.error("Нет confirmation_url в ответе ЮKassa:", payment);
      return res
        .status(500)
        .json({ error: "Не удалось получить ссылку на оплату" });
    }

    order.paymentId = payment.id;

    res.json({
      orderId,
      total,
      items,
      status: order.status,
      paymentStatus: order.paymentStatus,
      paymentUrl,
    });
  } catch (err) {
    console.error("Ошибка при создании заказа/платежа:", err);
    res.status(500).json({ error: "Ошибка при создании заказа" });
  }
});

app.get("/api/orders/:orderId", (req, res) => {
  const order = ORDERS.find((o) => o.id === req.params.orderId);
  if (!order) return res.status(404).json({ error: "Заказ не найден" });
  res.json(order);
});

// ================== webhook ЮKassa ==================

app.post(
  "/api/yookassa/webhook",
  express.json({ type: "application/json" }),
  (req, res) => {
    try {
      const event = req.body;
      const payment = event && event.object;
      if (!payment || !payment.metadata || !payment.metadata.orderId) {
        console.log("Webhook без orderId:", event);
        return res.status(200).send("ignored");
      }

      const { orderId } = payment.metadata;
      const status = payment.status; // pending, waiting_for_capture, succeeded, canceled...

      const order = ORDERS.find((o) => o.id === orderId);
      if (!order) {
        console.log("Webhook: заказ не найден", orderId);
        return res.status(200).send("ok");
      }

      order.paymentStatus = status;
      if (status === "succeeded") {
        order.status = "paid";
      } else if (status === "canceled") {
        order.status = "canceled";
      }

      console.log("Webhook: обновлён заказ", orderId, "=>", order.status);
      res.status(200).send("ok");
    } catch (e) {
      console.error("Ошибка обработки вебхука ЮKassa:", e);
      res.status(200).send("error");
    }
  }
);

// ================== АДМИН-ЭНДПОИНТЫ ==================

// список всех заказов
app.get("/api/admin/orders", requireAdmin, (req, res) => {
  const safeOrders = ORDERS.map((o) => ({
    id: o.id,
    total: o.total,
    status: o.status,
    paymentStatus: o.paymentStatus || null,
    createdAt: o.createdAt,
    customer: o.customer,
    items: o.items,
  }));
  res.json({ orders: safeOrders });
});

// обновление статуса заказа вручную
app.patch("/api/admin/orders/:orderId", requireAdmin, (req, res) => {
  const order = ORDERS.find((o) => o.id === req.params.orderId);
  if (!order) return res.status(404).json({ error: "Заказ не найден" });

  const { status } = req.body || {};
  const allowed = ["pending", "paid", "canceled", "shipped", "completed"];

  if (!status || !allowed.includes(status)) {
    return res.status(400).json({ error: "Некорректный статус" });
  }

  order.status = status;
  res.json({ ok: true, order });
});

app.listen(PORT, () => {
  console.log(`Sello backend listening on port ${PORT}`);
});
