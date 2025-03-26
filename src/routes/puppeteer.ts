import express from "express"
const router = express.Router()

router.get('/pup', (req, res) => {
  res.send('hi')
})

export default router