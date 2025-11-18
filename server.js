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

app.use(cors());
app.use(express.json());

// --- демо-продавцы ---
const SELLERS = [
  { id: "s-01", name: "Store Matvey", city: "Москва" },
  { id: "s-02", name: "Borovsky Retail", city: "Санкт-Петербург" },
  { id: "s-03", name: "Zhuk Select", city: "Казань" },
];

// --- демо-товары ---
const PRODUCTS = [
  {
    id: "p-01",
    title: "Aether Runner V2",
    brand: "Aether",
    price: 12990, // рубли
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

// простое хранилище заказов в памяти
const ORDERS = [];

// пересчёт корзины
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

// --- healthcheck ---
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", service: "sello-backend" });
});

// --- каталог ---
app.get("/api/products", (req, res) => {
  res.json({ products: PRODUCTS, sellers: SELLERS });
});

// --- создание заказа + платеж ЮKassa ---
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
      createdAt: new Date().toISOString(),
    };

    ORDERS.push(order);

    // чек для ЮKassa
    const receipt = {
      customer: {
        email:
          (customer && customer.email) ||
          "test@example.com", // заглушка, потом заменишь на реальный email покупателя
      },
      items: items.map((i) => ({
        description: i.title || "Товар",
        quantity: i.qty, // число
        amount: {
          value: i.price.toFixed(2), // строка, например "12990.00"
          currency: "RUB",
        },
        vat_code: 1, // заглушка, проверь нужный код НДС в кабинете ЮKassa
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
      description: `Sello: заказ ${orderId}`,
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
      paymentUrl,
    });
  } catch (err) {
    console.error("Ошибка при создании заказа/платежа:", err);
    res.status(500).json({ error: "Ошибка при создании заказа" });
  }
});

// --- просмотр заказа по id (на будущее) ---
app.get("/api/orders/:orderId", (req, res) => {
  const order = ORDERS.find((o) => o.id === req.params.orderId);
  if (!order) return res.status(404).json({ error: "Заказ не найден" });
  res.json(order);
});

app.listen(PORT, () => {
  console.log(`Sello backend listening on port ${PORT}`);
});
