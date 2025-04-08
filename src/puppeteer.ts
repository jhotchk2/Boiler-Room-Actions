import pg from 'pg'
import dotenv from 'dotenv'
import puppeteer from "puppeteer"

dotenv.config()
const { Pool } = pg

const pool = new Pool({
  connectionString: process.env.DB_URL,
});
pool.connect();

export async function getHltbAndBoil() {
  const { rows } = await pool.query(`SELECT * from "Buffer_Profiles"`)
  try {
    for (const profile of rows) {
      await hltbUpdate(profile.steam_id)
    }
  } catch (err) {
    console.log(err)
  } finally {
    await pool.query(`DELETE FROM "Buffer_Profiles"`)
  }
}

//function to update hltb scores for games in users library
export async function hltbUpdate (id) {
  const url = (`https://howlongtobeat.com/steam?userName=${id}`)
  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  page.setDefaultNavigationTimeout(10 * 60 * 1000)

  //Use a custom user agent because default throws a 403 error on HLTB
  const customUA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/111.0.0.0 Safari/537.36';

  await page.setUserAgent(customUA);
  await page.goto(url);
  await page.setViewport({width: 1080, height: 1024});

  //Sleep for 5 seconds to wait for table to load on HLTB
  await new Promise(f => setTimeout(f, 5000));

  const extractHLTBData = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('tr.spreadsheet')) //get array of table rows
      .map(row => { //map function to run on each row
        const steamLink = row.querySelector('a[href^="http://store.steampowered.com/app/"]'); //select store link from href
        if (!steamLink) return null;
  
        const appId = (steamLink as HTMLAnchorElement).href.match(/app\/(\d+)/)?.[1]; //select steamAppId from store link
        if (!appId) return null;
  
        const timeCell = row.querySelector('td.center, td.center.text_red'); //select HLTB time cell
        if (!timeCell) return null;
  
        //extract hltb time 
        const timeText = timeCell.textContent.trim();
        const timeMatch = timeText.match(/(?:(\d+)h)?\s*(?:(\d+)m)?/);
  
        //parse hours and minutes
        const hours = timeMatch?.[1] ? parseInt(timeMatch[1]) : 0;
        const minutes = timeMatch?.[2] ? parseInt(timeMatch[2]) : 0;
        const timeDecimal: number = +(hours + minutes / 60).toFixed(1); //convert to number rounded to 1 decimal point
  
        return [appId, timeDecimal];
      }).filter(entry => entry && entry[1] != '0');
  });

  await browser.close();


  // Update the database with extracted data
  try {
    for (const game of extractHLTBData) {
      const { rows } = await pool.query(
        `SELECT "metacritic_score"  
         FROM "Games" WHERE "game_id" = $1`,
        [game[0]]
      )
      const boil_score = rows[0]?.metacritic_score
      ? await boil_rating(game[1], rows[0]?.metacritic_score, 0.75)
      : null
      await pool.query(
        `UPDATE "Games" SET hltb_score = $1, boil_score = $2 WHERE game_id = $3`,
        [game[1], boil_score, game[0]]
      )
    }

    console.log('Database updated successfully')
    return { success: true, message: 'Games hltb updated successfully' };
  } catch (err) {
    console.error('Error updating database:', err);
    return { success: false, message: 'Games hltb not updated successfully' };
  }
}

//Function to return "boil rating" based on
async function boil_rating(hltb_score, rating, quality_weight) {
  quality_weight = quality_weight || 0.75 //the percentage that rating matters over length, 75% by default if null/falsy

  let lengthFactor : any;

  //if no length available, lengthfactor is assigned halfway between worst possible and average
  if (!hltb_score) lengthFactor = 2.5;

  //calculate a lengthFactor based on the hltb score, ex. 0.1hrs -> ~10LF, 18 hrs (avg game) -> ~5LF, 100hrs -> ~0LF
  else {
    lengthFactor = 10 * Math.exp(-1 * (Math.log(5) / 18) * (hltb_score - 0.1))
  }

  //calculate boil rating
  const boil_rating: number = +(
    rating * quality_weight +
    lengthFactor * (1 - quality_weight) * 10
  ).toFixed(1)

  return boil_rating
}

