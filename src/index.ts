import express from "express"
import dotenv from 'dotenv'
import cors from 'cors'
import pg from 'pg'
import { hltbUpdate } from './puppeteer'
import axios from "axios"

const app = express()
dotenv.config()
const { Pool } = pg;
const PORT = 9090

app.use(express.json())
app.use(cors())

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

app.get('/status', (req, res) => {
  res.status(200).send('online')
})

app.get('/cronjob', async (req, res) => {
  const response = await axios.get(process.env.URL + '/status')
  if (response.data == 'online') {
    console.log(response.data)
    const steamId = '76561199509790498' // jack
     try {
        await hltbUpdate(steamId)
        res.sendStatus(201)
      } catch (err) {
        console.log(err)
        res.status(500).json({error: 'Error fetching HLTB scores'})
      }
  }
})

app.get('/supabase', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM "Profiles"')
  res.json(rows)
})

export default app