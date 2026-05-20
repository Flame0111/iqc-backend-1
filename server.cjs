const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');

const app = express();
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'PUT', 'DELETE'], credentials: true }));
app.use(express.json()); 

const pool = new Pool({
  connectionString: "postgresql://neondb_owner:npg_KZ5XLtSWbO0i@ep-holy-star-ao9ueqj9-pooler.c-2.ap-southeast-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require"
});

async function initDatabase() {
  try {
    await pool.query(`ALTER TABLE iqc_records ADD COLUMN IF NOT EXISTS job_status VARCHAR(50) DEFAULT 'Awaiting';`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS pin_changing_requests (
        id SERIAL PRIMARY KEY,
        location VARCHAR(50),
        pin_no VARCHAR(100),
        stock_pin_no VARCHAR(100),
        name_socket VARCHAR(100),
        requested_by VARCHAR(100),
        accepted_by VARCHAR(100) DEFAULT NULL,
        status VARCHAR(50) DEFAULT 'Awaiting',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        completed_at TIMESTAMP DEFAULT NULL
      );
    `);
    console.log("🗄️ Database Sync Success.");
  } catch (err) { console.error("Migration Error: ", err.message); }
}
initDatabase();

const upload = multer({ dest: 'uploads/' });
const SECRET_KEY = "Utac_Iqc_Enterprise_Secret_2026_XyZ"; 

const usersDB = [
  { username: "viewer", password: "View@Only26!", role: "viewer", name: "Guest User" },
  { username: "user", password: "User@Iqc26!", role: "contactor", name: "IQC Engineer" },
  { username: "admin", password: "Admin@Secure26!", role: "admin", name: "System Admin" }
];

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const user = usersDB.find(u => u.username === username && u.password === password);
  if (user) {
    const token = jwt.sign({ username: user.username, role: user.role, name: user.name }, SECRET_KEY, { expiresIn: '8h' });
    res.json({ success: true, token, role: user.role, name: user.name });
  } else {
    res.status(401).json({ success: false, message: "Invalid credentials" });
  }
});

const verifyToken = (req, res, next) => {
  const token = req.headers['authorization']?.split(' ')[1];
  if (!token) return res.status(403).json({ message: "No token!" });
  jwt.verify(token, SECRET_KEY, (err, decoded) => {
    if (err) return res.status(401).json({ message: "Unauthorized!" });
    req.user = decoded; next();
  });
};

app.get('/api/iqc-list', verifyToken, async (req, res) => {
  try {
    const allRecords = await pool.query(`SELECT id, location, date_recv, created_at, owner, send_by, hw_name, serial_no, invoice_no, checked_by, iqc_result, job_status, checklist_data FROM iqc_records ORDER BY created_at DESC`);
    const stats = await pool.query(`SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE iqc_result = 'PASS') as pass_count, COUNT(*) FILTER (WHERE iqc_result = 'FAIL') as fail_count FROM iqc_records`);
    res.status(200).json({ success: true, stats: stats.rows[0], data: allRecords.rows });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/pin-change-list', verifyToken, async (req, res) => {
  try {
    const records = await pool.query(`SELECT * FROM pin_changing_requests ORDER BY created_at DESC`);
    res.status(200).json({ success: true, data: records.rows });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/pin-change-request', verifyToken, async (req, res) => {
  try {
    const { location, pin_no, stock_pin_no, name_socket } = req.body;
    await pool.query(`INSERT INTO pin_changing_requests (location, pin_no, stock_pin_no, name_socket, requested_by, status) VALUES ($1, $2, $3, $4, $5, 'Awaiting')`, 
    [location, pin_no, stock_pin_no, name_socket, req.user.name]);
    res.status(200).json({ success: true });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.put('/api/pin-change-accept/:id', verifyToken, async (req, res) => {
  try {
    await pool.query(`UPDATE pin_changing_requests SET status = 'Pending', accepted_by = $1 WHERE id = $2`, [req.user.name, req.params.id]);
    res.status(200).json({ success: true });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.put('/api/pin-change-complete/:id', verifyToken, async (req, res) => {
  try {
    await pool.query(`UPDATE pin_changing_requests SET status = 'Done', completed_at = NOW() WHERE id = $1`, [req.params.id]);
    res.status(200).json({ success: true });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on ${PORT}`));
