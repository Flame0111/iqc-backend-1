const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');

const app = express();
app.use(cors({ 
  origin: 'https://contactorweb.netlify.app', // เอา URL ของ Netlify มาใส่ (ลบ / เครื่องหมายสแลชท้ายสุดออกด้วยนะครับ)
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  credentials: true 
}));
app.use(express.json()); 

// 🌟 เอาลิงก์ Supabase (หรือ Cloud ตัวใหม่) ของคุณเฟมมาใส่ตรงนี้นะครับ
const pool = new Pool({
  connectionString: "postgresql://postgres.kjxhdmwbcxmaadxdolfg:Pmewmyhero007@aws-1-ap-southeast-1.pooler.supabase.com:6543/postgres"
});

async function initDatabase() {
  try {
    // 🌟 1. สร้างตารางหลัก iqc_records ก่อน (สำหรับ Database ใหม่ที่ยังโล่ง)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS iqc_records (
        id SERIAL PRIMARY KEY,
        hw_name VARCHAR(255),
        supplier VARCHAR(255),
        date_recv DATE,
        invoice_no VARCHAR(255),
        hw_desc TEXT,
        po_no VARCHAR(255),
        serial_no VARCHAR(255),
        customer VARCHAR(255),
        owner VARCHAR(255),
        send_by VARCHAR(255),
        location VARCHAR(255),
        checked_by VARCHAR(255),
        iqc_result VARCHAR(50),
        checklist_data JSONB,
        document_paths JSONB,
        image_paths JSONB,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // อัปเดตคอลัมน์เพิ่มเติมเผื่อไว้
    await pool.query(`ALTER TABLE iqc_records ADD COLUMN IF NOT EXISTS job_status VARCHAR(50) DEFAULT 'Awaiting';`);
    
    // 🌟 2. สร้างตาราง Pin Changing
    await pool.query(`
      CREATE TABLE IF NOT EXISTS pin_changing_requests (
        id SERIAL PRIMARY KEY,
        location VARCHAR(50),
        requested_by VARCHAR(100),
        accepted_by VARCHAR(100) DEFAULT NULL,
        status VARCHAR(50) DEFAULT 'Pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        completed_at TIMESTAMP DEFAULT NULL
      );
    `);
    
    // 3. เพิ่มคอลัมน์ใหม่ๆ ลงไป
    await pool.query(`ALTER TABLE pin_changing_requests ADD COLUMN IF NOT EXISTS pin_no VARCHAR(100);`);
    await pool.query(`ALTER TABLE pin_changing_requests ADD COLUMN IF NOT EXISTS stock_pin_no VARCHAR(100);`);
    await pool.query(`ALTER TABLE pin_changing_requests ADD COLUMN IF NOT EXISTS name_socket VARCHAR(100);`);
    await pool.query(`ALTER TABLE pin_changing_requests ADD COLUMN IF NOT EXISTS completed_at TIMESTAMP DEFAULT NULL;`);
    await pool.query(`ALTER TABLE pin_changing_requests ADD COLUMN IF NOT EXISTS customer_name VARCHAR(100);`);
    await pool.query(`ALTER TABLE pin_changing_requests ADD COLUMN IF NOT EXISTS req_name VARCHAR(100);`);
    
    console.log("🗄️ Database Sync Success. All tables and columns are ready.");
  } catch (err) { console.error("Migration Error: ", err.message); }
}
initDatabase();

const upload = multer({ 
  dest: 'uploads/',
  limits: { fileSize: 5 * 1024 * 1024 }, // บังคับขนาดไฟล์ห้ามเกิน 5MB
  fileFilter: (req, file, cb) => {
    // ยอมรับเฉพาะรูปภาพ และ PDF
    if (file.mimetype.startsWith('image/') || file.mimetype === 'application/pdf') {
      cb(null, true);
    } else {
      cb(new Error('ไม่อนุญาตให้อัปโหลดไฟล์ประเภทนี้!'));
    }
  }
});
const SECRET_KEY = "Utac_Iqc_Enterprise_Secret_2026_XyZ"; 

const usersDB = [
  { username: "user", password: "12345", role: "viewer", name: "User" },
  { username: "contactor", password: "Pmewmyhero007", role: "contactor", name: "Contactor Member" },
  { username: "admin", password: "Admin@Secure26!", role: "admin", name: "Administrator" }
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

// ==========================================
// IQC PROTOCOL APIs
// ==========================================
app.get('/api/iqc-list', verifyToken, async (req, res) => {
  try {
    const allRecords = await pool.query(`SELECT id, location, date_recv, created_at, owner, send_by, hw_name, serial_no, invoice_no, checked_by, iqc_result, job_status, checklist_data FROM iqc_records ORDER BY created_at DESC`);
    const stats = await pool.query(`SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE iqc_result = 'PASS') as pass_count, COUNT(*) FILTER (WHERE iqc_result = 'FAIL') as fail_count FROM iqc_records`);
    res.status(200).json({ success: true, stats: stats.rows[0], data: allRecords.rows });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.put('/api/iqc-status/:id', verifyToken, async (req, res) => {
  try {
    await pool.query('UPDATE iqc_records SET job_status = $1 WHERE id = $2', [req.body.status, req.params.id]);
    res.status(200).json({ success: true });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/submit-iqc', verifyToken, upload.any(), async (req, res) => {
  if (req.user.role === 'viewer') return res.status(403).json({ error: "Unauthorized" });
  try {
    const iqcData = JSON.parse(req.body.iqcData);
    const documentPaths = [];
    const imagePaths = [];
    req.files.forEach(file => {
      const ext = path.extname(file.originalname);
      const newPath = `${file.path}${ext}`;
      fs.renameSync(file.path, newPath);
      if (file.fieldname.startsWith('document_')) documentPaths.push({ type: file.fieldname, path: newPath });
      else if (file.fieldname.startsWith('image_')) imagePaths.push({ type: file.fieldname, path: newPath });
    });
    
    const primaryFields = ['hwName', 'supplier', 'dateRecv', 'invoiceNo', 'hwDesc', 'poNo', 'serialNo', 'customer', 'owner', 'sendBy', 'location', 'checkedBy', 'finalResult'];
    const checklistData = {};
    Object.keys(iqcData).forEach(key => { if (!primaryFields.includes(key)) checklistData[key] = iqcData[key]; });

    const insertQuery = `INSERT INTO iqc_records (hw_name, supplier, date_recv, invoice_no, hw_desc, po_no, serial_no, customer, owner, send_by, location, checked_by, iqc_result, job_status, checklist_data, document_paths, image_paths) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17) RETURNING id;`;
    
    const values = [
      iqcData.hwName, iqcData.supplier, iqcData.dateRecv || null, 
      iqcData.invoiceNo, iqcData.hwDesc, iqcData.poNo, 
      iqcData.serialNo, iqcData.customer, iqcData.owner, 
      iqcData.sendBy, iqcData.location, 
      iqcData.checkedBy || req.user.name, 
      iqcData.finalResult || 'PENDING', 'Awaiting', 
      JSON.stringify(checklistData), JSON.stringify(documentPaths), JSON.stringify(imagePaths)
    ];
    
    const result = await pool.query(insertQuery, values);
    res.status(200).json({ success: true, id: result.rows[0].id });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.delete('/api/iqc/:id', verifyToken, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: "Unauthorized" });
  try {
    const record = await pool.query('SELECT document_paths, image_paths FROM iqc_records WHERE id = $1', [req.params.id]);
    if (record.rows.length === 0) return res.status(404).json({ error: "Not found" });
    const docs = record.rows[0].document_paths || [];
    const imgs = record.rows[0].image_paths || [];
    [...docs, ...imgs].forEach(file => { const filePath = path.join(__dirname, file.path); if (fs.existsSync(filePath)) fs.unlinkSync(filePath); });
    await pool.query('DELETE FROM iqc_records WHERE id = $1', [req.params.id]);
    res.status(200).json({ success: true });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// ==========================================
// PIN CHANGING QUEUE APIs
// ==========================================
app.get('/api/pin-change-list', verifyToken, async (req, res) => {
  try {
    const records = await pool.query(`SELECT * FROM pin_changing_requests ORDER BY created_at DESC`);
    res.status(200).json({ success: true, data: records.rows });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/pin-change-request', verifyToken, async (req, res) => {
  try {
    const { location, pin_no, stock_pin_no, name_socket, customer_name, req_name } = req.body;
    await pool.query(
      `INSERT INTO pin_changing_requests (location, pin_no, stock_pin_no, name_socket, requested_by, customer_name, req_name, status) VALUES ($1, $2, $3, $4, $5, $6, $7, 'Pending')`,
      [location, pin_no, stock_pin_no, name_socket, req.user.name, customer_name, req_name]
    );
    res.status(200).json({ success: true, message: "Request created and auto-accepted" });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.put('/api/pin-change-complete/:id', verifyToken, async (req, res) => {
  try {
    await pool.query(`UPDATE pin_changing_requests SET status = 'Done', completed_at = NOW() WHERE id = $1`, [req.params.id]);
    res.status(200).json({ success: true });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.delete('/api/pin-change/:id', verifyToken, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: "Only Admin" });
  try {
    await pool.query(`DELETE FROM pin_changing_requests WHERE id = $1`, [req.params.id]);
    res.status(200).json({ success: true });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on ${PORT}`));
