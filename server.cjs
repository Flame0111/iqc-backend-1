const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');

const app = express();

// 🌟 เปิดประตูต้อนรับ Netlify และการรันข้ามโดเมน
app.use(cors({
  origin: '*', 
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  credentials: true
}));
app.use(express.json()); 

// 🌟 ตั้งค่า Database (ตอนเอาขึ้น Cloud ให้เอา connectionString จาก Neon.tech มาใส่แทน)
const pool = new Pool({
  user: 'postgres',
  host: 'localhost',
  database: 'iqc_db',
  password: 'passw0rd', // <--- รหัสผ่าน DB 
  port: 5432,
  connectionString: "postgresql://neondb_owner:npg_KZ5XLtSWb0Oi@ep-holy-star-ao9ueqj9.c-2.ap-southeast-1.aws.neon.tech/neondb?sslmode=require", // ใช้บรรทัดนี้ตอนขึ้น Cloud
});

// ตรวจสอบและเพิ่มคอลัมน์ให้อัตโนมัติ (ไม่มีคำสั่งลบตารางแน่นอน ข้อมูลไม่หายครับ!)
pool.query(`ALTER TABLE iqc_records ADD COLUMN IF NOT EXISTS job_status VARCHAR(50) DEFAULT 'Awaiting';`).catch(err => console.log("DB Notice: ", err.message));

const upload = multer({ dest: 'uploads/' });
const SECRET_KEY = "Utac_Iqc_Enterprise_Secret_2026_XyZ"; 

// 🔐 ฐานข้อมูล User
const usersDB = [
  { username: "viewer", password: "View@Only26!", role: "viewer", name: "Guest User" },
  { username: "user", password: "User@Iqc26!", role: "contactor", name: "Contactor Member" },
  { username: "admin", password: "Admin@Secure26!", role: "admin", name: "System Admin" }
];

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const user = usersDB.find(u => u.username === username && u.password === password);
  if (user) {
    const token = jwt.sign({ username: user.username, role: user.role, name: user.name }, SECRET_KEY, { expiresIn: '8h' });
    res.json({ success: true, token, role: user.role, name: user.name });
  } else {
    res.status(401).json({ success: false, message: "Invalid username or password" });
  }
});

const verifyToken = (req, res, next) => {
  const token = req.headers['authorization']?.split(' ')[1];
  if (!token) return res.status(403).json({ message: "No token provided!" });
  jwt.verify(token, SECRET_KEY, (err, decoded) => {
    if (err) return res.status(401).json({ message: "Unauthorized!" });
    req.user = decoded; 
    next();
  });
};

// API 1: Fetch Full Query List
app.get('/api/iqc-list', verifyToken, async (req, res) => {
  try {
    const allRecords = await pool.query(`
      SELECT id, location, date_recv, created_at, owner, send_by, hw_name, serial_no, invoice_no, checked_by, iqc_result, job_status, checklist_data
      FROM iqc_records ORDER BY created_at DESC
    `);
    const stats = await pool.query(`SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE iqc_result = 'PASS') as pass_count, COUNT(*) FILTER (WHERE iqc_result = 'FAIL') as fail_count FROM iqc_records`);
    res.status(200).json({ success: true, stats: stats.rows[0], data: allRecords.rows });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// API 2: Update Job Status
app.put('/api/iqc-status/:id', verifyToken, async (req, res) => {
  if (req.user.role === 'viewer') return res.status(403).json({ error: "Viewers cannot edit status" });
  try {
    await pool.query('UPDATE iqc_records SET job_status = $1 WHERE id = $2', [req.body.status, req.params.id]);
    res.status(200).json({ success: true, message: "Status updated" });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// API 3: Submit Form
app.post('/api/submit-iqc', verifyToken, upload.any(), async (req, res) => {
  if (req.user.role === 'viewer') return res.status(403).json({ error: "Viewers cannot submit forms" });

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
    const values = [iqcData.hwName, iqcData.supplier, iqcData.dateRecv || null, iqcData.invoiceNo, iqcData.hwDesc, iqcData.poNo, iqcData.serialNo, iqcData.customer, iqcData.owner, iqcData.sendBy, iqcData.location, req.user.name, iqcData.finalResult || 'PENDING', 'Awaiting', JSON.stringify(checklistData), JSON.stringify(documentPaths), JSON.stringify(imagePaths)];

    const result = await pool.query(insertQuery, values);
    res.status(200).json({ success: true, id: result.rows[0].id });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// API 4: Delete Record
app.delete('/api/iqc/:id', verifyToken, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: "Only administrators can delete records." });
  try {
    const record = await pool.query('SELECT document_paths, image_paths FROM iqc_records WHERE id = $1', [req.params.id]);
    if (record.rows.length === 0) return res.status(404).json({ error: "Record not found" });

    const docs = record.rows[0].document_paths || [];
    const imgs = record.rows[0].image_paths || [];
    [...docs, ...imgs].forEach(file => {
      const filePath = path.join(__dirname, file.path);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    });

    await pool.query('DELETE FROM iqc_records WHERE id = $1', [req.params.id]);
    res.status(200).json({ success: true });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.listen(3000, () => console.log('🚀 Backend Secure Auth Server รันแล้วที่ พอร์ต 3000'));