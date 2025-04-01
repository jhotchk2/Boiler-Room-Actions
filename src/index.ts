import dotenv from 'dotenv'
import cors from 'cors'
import pg from 'pg'
import { getHltbAndBoil } from './puppeteer'
import axios from "axios"
import express, {Request, Response} from 'express'

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

app.get('/', (req: Request, res: Response) => {
  res.status(200).json({message: 'hello'})
})

app.get('/status', (req, res) => {
  res.status(200).send('online')
})

app.get('/cronjob', async (req, res) => {
  const { data: status } = await axios.get(process.env.URL + '/status')
  if (status == 'online') {
    try {
      // function to update games can go here
      await getHltbAndBoil()
      res.sendStatus(201)
    } catch (err) {
      console.error(err)
      res.status(500).json({error: 'Error fetching HLTB scores'})
    }
  }
})

app.get('/supabase', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM "Profiles"')
  res.json(rows)
})

app.get('/load', async (req: Request, res: Response) => {
  try {
    const { rows } = await pool.query('SELECT * FROM "Buffer"');
    
    if (!rows || rows.length === 0) {
      res.status(404).json({ message: 'No games found in Buffer' });
      return;
    }

    const appIds = rows.map(row => row.steam_id);
    const gameDataPromises = appIds.map(async (appid) => {
      try {
        const response = await axios.get(
          'https://store.steampowered.com/api/appdetails',
          { params: { appids: appid } }
        );

        const gameData = response.data?.[appid]?.data;
        if (!gameData || !response.data?.[appid]?.success) {
          return {
            appid,
            name: 'Unknown',
            error: 'Invalid API response'
          };
        }

        let platformValue = 0;
        if (gameData.platforms) {
          platformValue += gameData.platforms.windows ? 4 : 0;
          platformValue += gameData.platforms.mac ? 2 : 0;
          platformValue += gameData.platforms.linux ? 1 : 0;
        }

        const parseReleaseDate = (dateString: string): string | null => {
          if (!dateString) return null;
          
          try {
            const date = new Date(dateString.replace(',', ''));
            
            if (isNaN(date.getTime())) {
              const parts = dateString.split(/[\s,-]+/);
              if (parts.length === 3) {
                const day = parts[0].padStart(2, '0');
                const month = new Date(`${parts[1]} 1, 2000`).getMonth() + 1;
                const year = parts[2];
                return `${year}-${month.toString().padStart(2, '0')}-${day.padStart(2, '0')}`;
              }
              return null;
            }
            
            return date.toISOString().split('T')[0];
          } catch (e) {
            console.error(`Failed to parse date: ${dateString}`, e);
            return null;
          }
        };

        let formattedDate = null;
        if (gameData.release_date?.date && !gameData.release_date.coming_soon) {
          formattedDate = parseReleaseDate(gameData.release_date.date);
        }

        return {
          appid,
          name: gameData.name || 'Unknown',
          header_image: gameData.header_image || null,
          metacritic_score: gameData.metacritic?.score || null,
          platforms: platformValue,
          categories: gameData.categories?.map(c => c.id) || [],
          genres: gameData.genres?.map(g => Number(g.id)) || [],
          developers: gameData.developers || [],
          publishers: gameData.publishers || [],
          short_description: gameData.short_description || null,
          release_date: formattedDate,
          dlcs: gameData.dlc ? gameData.dlc.map((id: string | number) => Number(id)) : []
        };
      } catch (error) {
        console.error(`Error for appid ${appid}:`, error);
        return { 
          appid,
          name: 'Error fetching data',
          error: error instanceof Error ? error.message : 'Unknown error'
        };
      }
    });

    const gameData = await Promise.all(gameDataPromises);
    res.json({ 
      success: true, 
      count: gameData.length, 
      games: gameData 
    });
  } catch (error) {
    console.error('Error in /load endpoint:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Internal server error' 
    });
  }
});

export default app