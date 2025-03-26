import express from "express"
import dotenv from 'dotenv'
import cors from 'cors'
import pg from 'pg'
import puppeteerRouter from './routes/puppeteer'

const app = express()
dotenv.config()
const { Pool } = pg;
const PORT = 9090

app.use(express.json())
app.use(cors())
app.use('/puppeteer', puppeteerRouter)

const pool = new Pool({
  connectionString: process.env.DB_URL,
});
pool.connect();

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`)
})

app.get('/', (req, res) => {
  res.status(200).json({message: 'hello'})
})

app.get('/supabase', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM "Profiles"')
  res.json(rows)
})



export default app