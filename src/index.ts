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

app.get('/renderStatus', async (req, res) => {
  const MAX_RETRIES = 20;
  const DELAY_MS = 8000; // 10 seconds
  const url = 'https://boiler-room-actions.onrender.com/status';

  for (let i = 0; i < MAX_RETRIES; i++) {
    try {
      const response = await axios.get(url);

      if (response.status === 200 && response.data === 'online') {
        res.status(200).send('Render app is online');
        return
      } else {
        console.log(`Attempt ${i + 1}: got status ${response.status}, retrying...`);
      }
    } catch (err) {
      console.log(`Attempt ${i + 1} failed:`, err.message);
    }

    await new Promise(resolve => setTimeout(resolve, DELAY_MS));
  }

  res.status(504).send('Render app did not respond in time');
  return
});

app.get('/status', (req, res) => {
  res.status(200).send('online')
})

app.get('/cronjob', async (req, res) => {
  try {
    await loadGames()
    await getHltbAndBoil()
    res.sendStatus(201)
  } catch (err) {
    console.error(err)
    res.status(500).json({error: 'Error fetching HLTB scores'})
  }
})

app.get('/supabase', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM "Profiles"')
  res.json(rows)
})

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function loadGames() {
  try {
    const { rows } = await pool.query('SELECT * FROM "Buffer_Games" LIMIT 100');
    
    if (!rows || rows.length === 0) {
      console.log('No games found in Buffer_Games');
      return;
    }

    const appIds = rows.map(row => {
      const appid = Number(row.game_id);
      if (isNaN(appid)) {
        console.warn(`Invalid game_id format: ${row.game_id}`);
      }
      return appid;
    }).filter(appid => !isNaN(appid));

    if (appIds.length === 0) {
      console.log({ 
        message: 'No valid game_ids found in Buffer_Games',
        totalEntries: rows.length,
        invalidEntries: rows.length - appIds.length
      });
      return;
    }

    console.log(`Attempting to fetch data for ${appIds.length} games from Steam API`);
    
    const gameDataPromises = appIds.map(async (appid) => {
      try {
        console.log(`Fetching data for appid: ${appid}`);
        
        const response = await axios.get(
          'https://store.steampowered.com/api/appdetails',
          {
            params: { 
              appids: appid,
              l: 'english'
            }
          }
        );

        for (let i = 0; i < 3; i++) {
          const iterationStart = Date.now();
          console.log(`Starting iteration ${i} at ${new Date(iterationStart).toISOString()}`);
          
          await sleep(i * 1000);
          
          const iterationEnd = Date.now();
          const iterationElapsed = (iterationEnd - iterationStart) / 1000;
          console.log(`Iteration ${i} completed in ${iterationElapsed.toFixed(2)} seconds`);
      }

        console.log(`Response for appid ${appid}:`, {
          status: response.status,
          statusText: response.statusText,
          data: response.data
        });

        if (!response.data || !response.data[appid]) {
          console.error(`Invalid response structure for appid ${appid}`);
          await pool.query('DELETE FROM "Buffer_Games" WHERE game_id = $1', [appid]);
          return {
            appid,
            name: 'Unknown',
            error: 'Invalid API response structure',
            status: response.status
          };
        }

        const apiResponse = response.data[appid];
        if (!apiResponse.success) {
          console.error(`API reported failure for appid ${appid}:`, apiResponse);
          await pool.query('DELETE FROM "Buffer_Games" WHERE game_id = $1', [appid]);
          return {
            appid,
            name: 'Unknown',
            error: 'Steam API reported failure',
            status: response.status,
            apiError: apiResponse
          };
        }

        const gameData = apiResponse.data;
        if (!gameData) {
          console.error(`No game data in response for appid ${appid}`);
          await pool.query('DELETE FROM "Buffer_Games" WHERE game_id = $1', [appid]);
          return {
            appid,
            name: 'Unknown',
            error: 'No game data in API response',
            status: response.status
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

        const processedGameData = {
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

        await insertGameData(processedGameData);
        
        let reviewData = null;
        try {
          const reviewsResponse = await axios.get(
            `https://store.steampowered.com/appreviews/${appid}`,
            {
              params: {
                json: 1,
                language: 'english',
                filter: 'all',
                purchase_type: 'all'
              }
            }
          );
          
          for (let i = 0; i < 3; i++) {
            const iterationStart = Date.now();
            console.log(`Starting iteration ${i} at ${new Date(iterationStart).toISOString()}`);
            
            await sleep(i * 1000);
            
            const iterationEnd = Date.now();
            const iterationElapsed = (iterationEnd - iterationStart) / 1000;
            console.log(`Iteration ${i} completed in ${iterationElapsed.toFixed(2)} seconds`);
        }
          
          if (reviewsResponse.data && reviewsResponse.data.success > 0) {
            reviewData = {
              review_score_desc: reviewsResponse.data.query_summary.review_score_desc,
              total_positive: reviewsResponse.data.query_summary.total_positive,
              total_negative: reviewsResponse.data.query_summary.total_negative,
              total_reviews: reviewsResponse.data.query_summary.total_reviews
            };
            
            await pool.query(
              `INSERT INTO "Game_Recommendations" 
               ("game_id", "total", "positive", "negative", "description") 
               VALUES ($1, $2, $3, $4, $5)
               ON CONFLICT ("game_id") DO UPDATE SET
               "total" = EXCLUDED."total",
               "positive" = EXCLUDED."positive",
               "negative" = EXCLUDED."negative",
               "description" = EXCLUDED."description"`,
              [
                appid,
                reviewData.total_reviews,
                reviewData.total_positive,
                reviewData.total_negative,
                reviewData.review_score_desc
              ]
            );
          }
        } catch (reviewError) {
          console.error(`Failed to fetch reviews for appid ${appid}:`, reviewError);
          reviewData = {
            error: reviewError instanceof Error ? reviewError.message : 'Unknown review error'
          };
        }

        await pool.query('DELETE FROM "Buffer_Games" WHERE game_id = $1', [appid]);
        
        return {
          ...processedGameData,
          review_data: reviewData,
          status: 'success'
        };
         
      } catch (error) {
        console.error(`Error processing appid ${appid}:`, {
          error: error instanceof Error ? error.stack : error,
          request: error.config ? {
            url: error.config.url,
            params: error.config.params,
            headers: error.config.headers
          } : null,
          response: error.response ? {
            status: error.response.status,
            data: error.response.data
          } : null
        });
        
        const shouldDeleteFromBuffer = error.response?.status !== 429;
        
        if (shouldDeleteFromBuffer) {
          await pool.query('DELETE FROM "Buffer_Games" WHERE game_id = $1', [appid]);
        }
        
        return { 
          appid,
          name: 'Error fetching data',
          error: error instanceof Error ? error.message : 'Unknown error',
          statusCode: error.response?.status,
          shouldRetry: error.response?.status === 429
        };
      }
    });

    const gameData = await Promise.all(gameDataPromises);
    
    const successful = gameData.filter(g => !g.error);
    const failed = gameData.filter(g => g.error);
    
    console.log(`Processed ${gameData.length} games: ${successful.length} success, ${failed.length} failed`);
    
    console.log({ 
      success: true, 
      count: {
        total: gameData.length,
        success: successful.length,
        failed: failed.length
      },
      successful,
      failed
    });
  } catch (error) {
    console.error('Critical error in /load endpoint:', {
      error: error instanceof Error ? error.stack : error,
      timestamp: new Date().toISOString()
    });
    console.log({ 
      success: false, 
      error: 'Internal server error',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
};

async function insertGameData(gameData) {
  try {
    await pool.query(
      `INSERT INTO "Games" ("game_id", "name", "header_image", "platform", "metacritic_score", "released", "description") 
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        gameData.appid,
        gameData.name,
        gameData.header_image,
        gameData.platforms,
        gameData.metacritic_score,
        gameData.release_date,
        gameData.short_description
      ]
    );

    for (const developer of gameData.developers) {
      await pool.query(
        `INSERT INTO "Developers" ("developers") VALUES ($1) 
         ON CONFLICT DO NOTHING`,
        [developer]
      );
      
      await pool.query(
        `INSERT INTO "Game_Developers" ("game_id", "developer") VALUES ($1, $2)`,
        [gameData.appid, developer]
      );
    }

    for (const publisher of gameData.publishers) {
      await pool.query(
        `INSERT INTO "Publishers" ("publisher") VALUES ($1) 
         ON CONFLICT DO NOTHING`,
        [publisher]
      );
      
      await pool.query(
        `INSERT INTO "Game_Publishers" ("game_id", "publisher") VALUES ($1, $2)`,
        [gameData.appid, publisher]
      );
    }

    for (const category of gameData.categories) {
      await pool.query(
        `INSERT INTO "Game_Category" ("game_id", "category") VALUES ($1, $2)`,
        [gameData.appid, category]
      );
    }

    for (const genre of gameData.genres) {
      await pool.query(
        `INSERT INTO "Game_Genres" ("games", "genres") VALUES ($1, $2)`,
        [gameData.appid, genre]
      );
    }

    for (const dlc of gameData.dlcs) {
      await pool.query(
        `INSERT INTO "DLCs" ("dlc_id", "main_game") VALUES ($1, $2)`,
        [dlc, gameData.appid]
      );
    }

    console.log(`Successfully inserted game data for ${gameData.name}`);
  } catch (error) {
    console.error(`Error inserting game data for ${gameData.name}:`, error);
    throw error;
  }
}

export default app