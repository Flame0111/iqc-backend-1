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

// 🔴 ใช้ : ไม่ใช่ = ในการตั้งค่า Connection
const pool = new Pool({
  connectionString: "postgresql://neondb_owner:npg_KZ5XLtSWb0Oi@ep-holy-star-ao9ueqj9-pooler.c-2.ap-southeast-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require"
});

async function initDatabase() {
  try {
    // ใช้ ALTER TABLE เพื่อเพิ่มคอลัมน์โดยไม่ทำลายข้อมูลเดิม
    await pool.query(`ALTER TABLE iqc_records ADD COLUMN IF NOT EXISTS job_status VARCHAR(50) DEFAULT 'Awaiting';`);

    // สร้างตาราง pin_changing_requests โดยไม่มี Comment // กวนใจ
    await pool.query(`
      CREATE TABLE IF NOT EXISTS pin_changing_requests (
        id SERIAL PRIMARY KEY,
        location VARCHAR(50),
        contac_no VARCHAR(100),
        contac_sn VARCHAR(100),
        requested_by VARCHAR(100),
        accepted_by VARCHAR(100) DEFAULT NULL,
        status VARCHAR(50) DEFAULT 'Awaiting',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        completed_at TIMESTAMP DEFAULT NULL
      );
    `);

    // เพิ่มคอลัมน์ completed_at ให้ตาราง pin_changing_requests
    await pool.query(`ALTER TABLE pin_changing_requests ADD COLUMN IF NOT EXISTS completed_at TIMESTAMP DEFAULT NULL;`);
    
    console.log("🗄️ Database Sync Success.");
  } catch (err) { 
    console.error("Migration Error: ", err.message); 
  }
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
    const values = [iqcData.hwName, iqcData.supplier, iqcData.dateRecv || null, iqcData.invoiceNo, iqcData.hwDesc, iqcData.poNo, iqcData.serialNo, iqcData.customer, iqcData.owner, iqcData.sendBy, iqcData.location, req.user.name, iqcData.finalResult || 'PENDING', 'Awaiting', JSON.stringify(checklistData), JSON.stringify(documentPaths), JSON.stringify(imagePaths)];
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

app.get('/api/pin-change-list', verifyToken, async (req, res) => {
  try {
    const records = await pool.query(`SELECT id, location, contac_no, contac_sn, requested_by, accepted_by, status, created_at, completed_at FROM pin_changing_requests ORDER BY created_at DESC`);
    res.status(200).json({ success: true, data: records.rows });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/pin-change-request', verifyToken, async (req, res) => {
  try {
    const { location, contac_no, contac_sn } = req.body;
    await pool.query(`INSERT INTO pin_changing_requests (location, contac_no, contac_sn, requested_by, status) VALUES ($1, $2, $3, $4, 'Awaiting')`, [location, contac_no, contac_sn, req.user.name]);
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

app.delete('/api/pin-change/:id', verifyToken, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: "Only Admin" });
  try {
    await pool.query(`DELETE FROM pin_changing_requests WHERE id = $1`, [req.params.id]);
    res.status(200).json({ success: true });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on ${PORT}`));
