// 1) пользователь отправляет email/phone → генерим код и шлём
app.post("/api/users/request-code", async (req, res) => {
  try {
    const { fullName, email, phone, city, role } = req.body || {};

    if (!email && !phone) {
      return res.status(400).json({ error: "Нужен email или телефон" });
    }

    // допустимые роли
    const userRole = role === "seller" ? "seller" : "buyer";

    const code = generateCode();
    const expires = new Date(Date.now() + 10 * 60 * 1000); // 10 минут

    // upsert по email (если есть) или по телефону
    // берём email как основной идентификатор, если он есть
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

    if (email) {
      await sendEmail(email, "Код подтверждения SelloMarket", msg);
    }
    if (phone) {
      await sendSms(phone, msg);
    }

    res.json({
      ok: true,
      userId: user.id,
      role: user.role
    });
  } catch (e) {
    console.error("Ошибка /api/users/request-code:", e);
    res.status(500).json({ error: "Ошибка при отправке кода" });
  }
});
