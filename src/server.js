// server.js — простой бэкенд с товарами

import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";

const app = express();
app.use(cors());
app.use(express.json());

const __dirname = path.resolve();
const DATA_FILE = path.join(__dirname, "products.json");

// чтение товаров из файла
function readProducts() {
  if (!fs.existsSync(DATA_FILE)) return [];
  const txt = fs.readFileSync(DATA_FILE, "utf8") || "[]";
  try {
    return JSON.parse(txt);
  } catch {
    return [];
  }
}
function writeProducts(arr) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(arr, null, 2));
}

// список товаров
app.get("/products", (req, res) => {
  res.json(readProducts());
});

// добавление товара (JSON, без загрузки файла — превью через imageUrl)
app.post("/products", (req, res) => {
  const { title, price, description, imageUrl, category, sellerEmail } =
    req.body || {};
  if (!title || !price) {
    return res.status(400).json({ error: "title и price обязательны" });
  }
  const products = readProducts();
  const product = {
    id: Date.now().toString(),
    title,
    price: Number(price),
    description: description || "",
    imageUrl: imageUrl || "",
    category: category || "",
    sellerEmail: sellerEmail || "",
    createdAt: new Date().toISOString()
  };
  products.push(product);
  writeProducts(products);
  res.json(product);
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log("Sello backend on", PORT));
