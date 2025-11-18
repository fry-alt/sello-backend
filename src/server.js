import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { YooKassa } from "yookassa";

dotenv.config();

const app = express();
app.use(express.json());
app.use(cors());

// ------------------------------
// YooKassa init
// ------------------------------
const yooKassa = new YooKassa({
    shopId: process.env.YOOKASSA_SHOP_ID,
    secretKey: process.env.YOOKASSA_SECRET_KEY
});

// ------------------------------
// API: Создать платеж
// ------------------------------
app.post("/api/create-payment", async (req, res) => {
    try {
        const { amount, description, orderId } = req.body;

        if (!amount || !description || !orderId) {
            return res.status(400).json({ error: "Missing required fields" });
        }

        const payment = await yooKassa.createPayment({
            amount: {
                value: amount,
                currency: "RUB"
            },
            confirmation: {
                type: "redirect",
                return_url: process.env.YOOKASSA_RETURN_URL
            },
            capture: true,
            description,
            metadata: {
                orderId
            }
        });

        res.json({ confirmationUrl: payment.confirmation.confirmation_url });

    } catch (error) {
        console.error("Ошибка при создании платежа:", error);
        res.status(500).json({ error: "Payment creation failed" });
    }
});

// ------------------------------
// Webhook (подтверждение оплаты)
// ------------------------------
app.post("/webhook", async (req, res) => {
    try {
        const event = req.body;

        // YooKassa требует ответ 200 сразу
        res.sendStatus(200);

        if (event.event === "payment.succeeded") {
            console.log("Платёж подтверждён:", event.object.id);

            // TODO: обновление заказа в БД, отправка уведомлений — позже добавим
        }
    } catch (error) {
        console.error("Ошибка вебхука:", error);
    }
});

// ------------------------------
// Admin login (без БД, упрощённо)
// позже заменим на нормальную авторизацию
// ------------------------------
app.post("/admin/login", (req, res) => {
    const { username, password } = req.body;

    if (
        username === process.env.ADMIN_LOGIN &&
        password === process.env.ADMIN_PASSWORD
    ) {
        return res.json({ success: true, token: "sello_admin_token" });
    }

    res.status(401).json({ error: "Invalid credentials" });
});

// ------------------------------
// Admin: список заказов (пока мок)
// позже подключим базу
// ------------------------------
app.get("/admin/orders", (req, res) => {
    res.json([
        { id: 1, name: "Тестовый товар", status: "paid" },
        { id: 2, name: "Кофта SELLÖ", status: "pending" }
    ]);
});

// ------------------------------
// Default route
// ------------------------------
app.get("/", (req, res) => {
    res.send("Sello backend is running");
});

// ------------------------------
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
    console.log(`Sello backend running on port ${PORT}`);
});
