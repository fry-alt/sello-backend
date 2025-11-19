const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const { YooKassa } = require("yookassa");
const { Pool } = require("pg");

dotenv.config();

const PORT = process.env.PORT || 4000;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error("DATABASE_URL не задан");
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const app = express();
app.use(express.json());
app.use(cors());

// ------------------------ DEMO-ДАННЫЕ ПРОДАВЦОВ И ТОВАРОВ (пока без БД) ------------------------

const SELLERS = [
  { id: "s-01", name: "Store Matvey", city: "Москва" },
  { id: "s-02", name: "Borovsky Retail", city: "Санкт-Петербург" },
  { id: "s-03", name: "Zhuk Select", city: "Казань" }
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
    badge: "Новинка"
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
    badge: "Хит"
  },
  {
    id: "p-03",
    title: "Linea Tote 24",
    brand: "Linea",
    price: 10990,
    category: "Сумки",
    sellerId: "s-03",
    colors: ["Песочный", "Олива"],
    sizes: ["OS"]
  },
  {
    id: "p-04",
    title: "Vertex Raw Denim",
    brand: "Vertex",
    price: 8990,
    category: "Джинсы",
    sellerId: "s-01",
    colors: ["Индиго"],
    sizes: ["30", "31", "32", "33"]
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
    badge: "-15%"
  },
  {
    id: "p-06",
    title: "Aether Glide",
    brand: "Aether",
    price: 11990,
    category: "Кроссовки",
    sellerId: "s-03",
    colors: ["Белый"],
    sizes: ["41", "42", "43"]
  }
];

// ------------------------ YOOKASSA ------------------------

const yooKassa = new YooKassa({
  shopId: process.env.YOOKASSA_SHOP_ID,
  secretKey: process.env.YOOKASSA_SECRET_KEY
});

// ------------------------ ИНИЦИАЛИЗАЦИЯ БД ------------------------

async function initDb() {
  await pool.query(`
    create table if not exists orders (
      id text primary key,
      total integer not null,
      status text not null,
      payment_status text,
      customer jsonb,
      created_at timestamptz default now(),
      payment_id text
    );
  `);

  await pool.query(`
    create table if not exists order_items (
      id serial primary key,
      order_id text not null references orders(id) on delete cascade,
      product_id text,
      title text,
      price integer,
      qty integer,
      seller_id text
    );
  `);

  console.log("DB init complete");
}

// ------------------------ УТИЛИТЫ ------------------------

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
        sellerId: product.sellerId
      };
    })
    .filter(Boolean);

  const total = items.reduce((s, i) => s + i.qty * i.price, 0);
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

// ------------------------ ПУБЛИЧНЫЕ ЭНДПОИНТЫ ------------------------

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

    // сохраняем заказ и позиции в БД
    await pool.query(
      `
      insert into orders (id, total, status, payment_status, customer)
      values ($1, $2, $3, $4, $5)
    `,
      [orderId, total, "pending", "pending", customer || {}]
    );

    const values = [];
    const params = [];
    let idx = 1;
    for (const it of items) {
      values.push(
        `($${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++})`
      );
      params.push(
        orderId,
        it.productId,
        it.title,
        it.price,
        it.qty,
        it.sellerId
      );
    }

    await pool.query(
      `
      insert into order_items (order_id, product_id, title, price, qty, seller_id)
      values ${values.join(",")}
    `,
      params
    );

    // создаём платёж в ЮKassa
    const receipt = {
      customer: {
        email:
          (customer && customer.email) ||
          "test@example.com" // потом можно сделать обязательным
      },
      items: items.map((i) => ({
        description: i.title || "Товар",
        quantity: i.qty,
        amount: {
          value: i.price.toFixed(2),
          currency: "RUB"
        },
        vat_code: 1
      }))
    };

    const payment = await yooKassa.createPayment({
      amount: {
        value: total.toFixed(2),
        currency: "RUB"
      },
      capture: true,
      confirmation: {
        type: "redirect",
        return_url: process.env.YOOKASSA_RETURN_URL
      },
      description: `SelloMarket: заказ ${orderId}`,
      metadata: { orderId },
      receipt
    });

    const paymentUrl = payment.confirmation?.confirmation_url;
    if (!paymentUrl) {
      console.error("Нет confirmation_url в ответе ЮKassa:", payment);
      return res
        .status(500)
        .json({ error: "Не удалось получить ссылку на оплату" });
    }

    await pool.query(
      `update orders set payment_id = $1 where id = $2`,
      [payment.id, orderId]
    );

    res.json({
      orderId,
      total,
      items,
      status: "pending",
      paymentStatus: "pending",
      paymentUrl
    });
  } catch (err) {
    console.error("Ошибка при создании заказа:", err);
    res.status(500).json({ error: "Ошибка при создании заказа" });
  }
});

app.get("/api/orders/:orderId", async (req, res) => {
  const { orderId } = req.params;
  const { rows } = await pool.query(`select * from orders where id = $1`, [
    orderId
  ]);
  if (!rows.length) return res.status(404).json({ error: "Заказ не найден" });
  res.json(rows[0]);
});

// ------------------------ WEBHOOK YOOKASSA ------------------------

app.post(
  "/api/yookassa/webhook",
  express.json({ type: "application/json" }),
  async (req, res) => {
    try {
      const event = req.body;
      const payment = event && event.object;
      if (!payment || !payment.metadata || !payment.metadata.orderId) {
        console.log("Webhook без orderId");
        return res.status(200).send("ignored");
      }

      const { orderId } = payment.metadata;
      const status = payment.status;

      let newStatus = "pending";
      if (status === "succeeded") newStatus = "paid";
      else if (status === "canceled") newStatus = "canceled";

      await pool.query(
        `update orders set status = $1, payment_status = $2 where id = $3`,
        [newStatus, status, orderId]
      );

      console.log("Webhook: заказ", orderId, "=>", newStatus);
      res.status(200).send("ok");
    } catch (e) {
      console.error("Ошибка вебхука ЮKassa:", e);
      res.status(200).send("error");
    }
  }
);

// ------------------------ АДМИН-ЭНДПОИНТЫ ------------------------

app.get("/api/admin/orders", requireAdmin, async (req, res) => {
  const { rows } = await pool.query(
    `select id, total, status, payment_status as "paymentStatus",
            customer, created_at as "createdAt"
     from orders
     order by created_at desc`
  );
  res.json({ orders: rows });
});

app.patch("/api/admin/orders/:orderId", requireAdmin, async (req, res) => {
  const { orderId } = req.params;
  const { status } = req.body || {};

  const allowed = ["pending", "paid", "canceled", "shipped", "completed"];
  if (!status || !allowed.includes(status)) {
    return res.status(400).json({ error: "Некорректный статус" });
  }

  const result = await pool.query(
    `update orders set status = $1 where id = $2 returning id, total, status, payment_status as "paymentStatus", customer, created_at as "createdAt"`,
    [status, orderId]
  );

  if (!result.rows.length) {
    return res.status(404).json({ error: "Заказ не найден" });
  }

  res.json({ ok: true, order: result.rows[0] });
});

// ------------------------ СТАРТ ------------------------

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Sello backend listening on port ${PORT}`);
    });
  })
  .catch((e) => {
    console.error("Ошибка инициализации БД:", e);
    process.exit(1);
  });
