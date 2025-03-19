import express from "express"
import dotenv from 'dotenv'
import cors from 'cors'

const app = express()
dotenv.config()
const PORT = 9090

app.use(express.json())
app.use(cors())


// To run the server 
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`)
})

app.get('/', (req, res) => {
  res.status(200).json({message: 'hello'})
})

export default app