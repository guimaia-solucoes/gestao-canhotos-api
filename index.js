import express from 'express';
import cors from 'cors';
import 'dotenv/config';

const app = express();

app.use(cors({
  origin: '*'
}));

app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'ok', node: process.version });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`API rodando na porta ${PORT}`);
});
