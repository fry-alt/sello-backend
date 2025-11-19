const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const { Pool } = require("pg");
const YooKassa = require("yookassa");
const nodemailer = require("nodemailer");

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

// ------------ YooKassa ------------

const yooKassa = new YooKassa({
  shopId: process.env.YOOKASSA_SHOP_ID,
  secretKey: process.env.YOOKASSA_SECRET_KEY
});

// ------------ SMTP (email) ------------

let mailer = null;
if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
  mailer = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: false,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });
  console.log("SMTP транспортер инициализирован");
} else {
  console.log("SMTP не настроен, отправка email-кодов отключена");
}

async function sendEmail(to, subject, text) {
  if (!mailer) {
    console.log("[DEV] email отправка выключена. Кому:", to, "Текст:", text);
    return;
  }
  await mailer.sendMail({
    from: process.env.SMTP_FROM || "SelloMarket <no-reply@sellomarket.ru>",
    to,
    subject,
    text
  });
}

// заглушка под SMS
async function sendSms(phone, text) {
  console.log("[DEV] SMS отправка заглушка. Телефон:", phone, "Текст:", text);
}

// ------------ INIT DB ------------

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

  await pool.query(`
    create table if not exists users (
      id serial primary key,
      full_name text,
      email text,
      phone text,
      city text,
      role text not null default 'buyer',
      is_verified boolean not null default false,
      verification_code text,
      verification_expires_at timestamptz,
      created_at timestamptz default now()
    );
  `);

  await pool.query(`
    create unique index if not exists users_email_unique
      on users (lower(email))
      where email is not null;
  `);

  await pool.query(`
    create unique index if not exists users_phone_unique
      on users (phone)
      where phone is not null;
  `);

  await pool.query(`
    create table if not exists sellers (
      id serial primary key,
      name text not null,
      contact_name text,
      email text,
      phone text,
      city text,
      description text,
      instagram text,
      website text,
      status text not null default 'pending',
      created_at timestamptz default now()
    );
  `);

  console.log("DB init complete");
}

// ------------ DEMO PRODUCTS ------------

const SELLERS_DEMO = [
  { id: "s-01", name: "Store Matvey", city: "Москва" },
  { id: "s-02", name: "Borovsky Retail", city: "Санкт-Петербург" },
  { id: "s-03", name: "Zhuk Select", city: "Казань" }
];

const PRODUCTS_DEMO = [
  {
    id: "p-01",
    title: "Aether Runner V2",
    brand: "Aether",
    price: 12990,
    category: "Кроссовки",
    sellerId: "s-01"
  },
  {
    id: "p-02",
    title: "Noir Shell Parka",
    brand: "Noir",
    price: 24990,
    category: "Куртки",
    sellerId: "s-02"
  },
  {
    id: "p-03",
    title: "Linea Tote 24",
    brand: "Linea",
    price: 10990,
    category: "Сумки",
    sellerId: "s-03"
  }
];

// ------------ UTILS ------------

function calcOrderSummary(cart) {
  const items = cart
    .map((ci) => {
      const product = PRODUCTS_DEMO.find((p) => p.id === ci.id);
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

function generateCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

// ------------ PUBLIC API ------------

app.get("/api/health", (req, res) => {
  res.json({ status: "ok", service: "sello-backend" });
});

app.get("/api/products", (req, res) => {
  res.json({ products: PRODUCTS_DEMO, sellers: SELLERS_DEMO });
});

// запрос кода (email/phone, роль buyer/seller)
app.post("/api/users/request-code", async (req, res) => {
  try {
    const { fullName, email, phone, city, role } = req.body || {};

    if (!email && !phone) {
      return res.status(400).json({ error: "Нужен email или телефон" });
    }

    const userRole = role === "seller" ? "seller" : "buyer";

    const code = generateCode();
    const expires = new Date(Date.now() + 10 * 60 * 1000);

    const result = await pool.query(
      `
      insert into users (full_name, email, phone, city, role, is_verified, verification_code, verification_expires_at)
      values ($1, $2, $3, $4, $5, false, $6, $7)
      on conflict (lower(email)) where $2 is not null
        do update set
          full_name = excluded.full_name,
          phone = excluded.phone,
          city = excluded.city,
          role = excluded.role,
          is_verified = false,
          verification_code = excluded.verification_code,
          verification_expires_at = excluded.verification_expires_at
      returning id, full_name as "fullName", email, phone, city, role, is_verified as "isVerified"
      `,
      [fullName || null, email || null, phone || null, city || null, userRole, code, expires]
    );

    const user = result.rows[0];

    const msg = `Код подтверждения SelloMarket: ${code}\nОн действует 10 минут.`;
    if (email) await sendEmail(email, "Код подтверждения SelloMarket", msg);
    if (phone) await sendSms(phone, msg);

    res.json({ ok: true, userId: user.id, role: user.role });
  } catch (e) {
    console.error("Ошибка /api/users/request-code:", e);
    res.status(500).json({ error: "Ошибка при отправке кода" });
  }
});

// проверка кода
app.post("/api/users/verify-code", async (req, res) => {
  try {
    const { email, phone, code } = req.body || {};

    if (!code || (!email && !phone)) {
      return res.status(400).json({ error: "Нужен код и email или телефон" });
    }

    const whereField = email ? "lower(email) = lower($1)" : "phone = $1";
    const value = email || phone;

    const result = await pool.query(
      `
      select *
      from users
      where ${whereField}
      limit 1
      `,
      [value]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: "Пользователь не найден" });
    }

    const user = result.rows[0];

    if (!user.verification_code || !user.verification_expires_at) {
      return res.status(400).json({ error: "Код не запрошен" });
    }

    const now = new Date();
    const expires = new Date(user.verification_expires_at);

    if (now > expires) {
      return res.status(400).json({ error: "Код истёк" });
    }

    if (String(code).trim() !== String(user.verification_code).trim()) {
      return res.status(400).json({ error: "Неверный код" });
    }

    const updated = await pool.query(
      `
      update users
         set is_verified = true,
             verification_code = null,
             verification_expires_at = null
       where id = $1
       returning id,
                 full_name as "fullName",
                 email,
                 phone,
                 city,
                 role,
                 is_verified as "isVerified",
                 created_at as "createdAt"
      `,
      [user.id]
    );

    res.json({ ok: true, user: updated.rows[0] });
  } catch (e) {
    console.error("Ошибка /api/users/verify-code:", e);
    res.status(500).json({ error: "Ошибка при проверке кода" });
  }
});

// получить данные продавца по email
app.get("/api/sellers/my", async (req, res) => {
  const { email } = req.query || {};
  if (!email) {
    return res.status(400).json({ error: "Нужен email" });
  }

  const result = await pool.query(
    `
    select id,
           name,
           contact_name as "contactName",
           email,
           phone,
           city,
           description,
           instagram,
           website,
           status,
           created_at as "createdAt"
      from sellers
     where lower(email) = lower($1)
     order by created_at desc
     limit 1
    `,
    [email]
  );

  if (!result.rows.length) {
    return res.json({ seller: null });
  }

  res.json({ seller: result.rows[0] });
});

// регистрация продавца (заявка)
app.post("/api/sellers/register", async (req, res) => {
  try {
    const {
      name,
      contactName,
      email,
      phone,
      city,
      description,
      instagram,
      website
    } = req.body || {};

    if (!name) {
      return res.status(400).json({ error: "Нужно название магазина" });
    }

    const result = await pool.query(
      `
      insert into sellers (name, contact_name, email, phone, city, description, instagram, website, status)
      values ($1,$2,$3,$4,$5,$6,$7,$8,'pending')
      returning id,
                name,
                contact_name as "contactName",
                email,
                phone,
                city,
                description,
                instagram,
                website,
                status,
                created_at as "createdAt"
      `,
      [
        name,
        contactName || null,
        email || null,
        phone || null,
        city || null,
        description || null,
        instagram || null,
        website || null
      ]
    );

    res.json({ ok: true, seller: result.rows[0] });
  } catch (e) {
    console.error("Ошибка регистрации продавца:", e);
    res.status(500).json({ error: "Ошибка регистрации продавца" });
  }
});

// создание заказа (упрощённо)
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

    await pool.query(
      `
      insert into orders (id, total, status, payment_status, customer)
      values ($1, $2, 'pending', 'pending', $3)
    `,
      [orderId, total, customer || {}]
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

    const receipt = {
      customer: {
        email: (customer && customer.email) || "test@example.com"
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

// ------------ START ------------

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
