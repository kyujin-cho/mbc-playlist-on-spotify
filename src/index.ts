import Axios from 'axios'
import cheerio from 'cheerio'
import Express from 'express'
import fs from 'fs'
import YAML from 'js-yaml'
import Fetch from 'node-fetch'
import Spotify from 'spotify-web-api-node'
import { Telegraf } from 'telegraf'
import HTMLUnescape from 'unescape'

const SEQ_ID_REGEX = /seqID=([0-9]+)/

const CONFIG_PATH = process.env.CONFIG_PATH || './config.yml'

const SKIPPED_TRACKS = [
  ['Vienna Symphonic Orchestra Project', 'Satisfaction'],
  ['Acoustic Alchemy', 'Ballad For Kay'],
]
/**
 * Waits for OAuth login response
 *
 * @param {string} authURL - OAuth redirect URL
 * @param {number} port - server port to listen
 */
const waitForOAuthRedirect = async (authURL: string, port: number) => {
  return new Promise<string>((resolve) => {
    const app = Express()
    app.get('/callback', (req, res) => {
      const code = req.query.code
      if (!code) {
        res.sendStatus(400)
      }
      resolve(code as string)
      res.send(`<script>window.close();</script>`)
    })
    app.listen(port, () => {
      console.log(
        `Navigate to this URL and log in with your Spotify Account: ${authURL}`
      )
    })
  })
}

/**
 * Sleep for given seconds
 *
 * @param {number} seconds - number of seconds to sleep
 */
const sleep = async (seconds: number) => {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, seconds * 1000)
  })
}

/**
 * Save config to disk
 *
 * @param {IConfig} config - config object
 */
const saveConfig = async (config: IConfig) => {
  await fs.promises.writeFile(CONFIG_PATH, YAML.dump(config))
  console.log(
    `Config ${JSON.stringify(config, null, 2)} saved to ${CONFIG_PATH}`
  )
}

interface IConfig {
  targetRadioStation: string
  stationName: string
  lastVisited: number
  maxBulkImportSize: number
  OAuthHandlerPort: 31208
  spotify: {
    clientId: string
    clientSecret: string
    refreshToken: string
  }
  telegram?: {
    botToken: string
    channel: string
  }
}

interface ITrack {
  name: string
  artist: string
  spotifyTrack?: SpotifyApi.TrackObjectFull
}

type Optional<T> = T | undefined

const createPlaylist = async (
  config: IConfig,
  targetId: number,
  bot: Optional<Telegraf>,
  spotify: Spotify
) => {
  const getUrl = `https://miniweb.imbc.com/Music/View?progCode=${config.targetRadioStation}&seqID=${targetId}`
  console.log('Querying', getUrl)
  const response = await Fetch(getUrl)
  const $ = cheerio.load(await response.text())
  const title = $('div.view-title p.title').eq(0).text().trim()
  const tracks = $('table.list-type tbody tr')
    .toArray()
    .map((item) => {
      const $ = cheerio.load(item)
      const title = $('td').eq(1).text().trim()
      let name = ''
      for (let i = 0; i < title.length; i++) {
        if (title[i] === '(') {
          let level = 1
          let j = i
          for (; j < title.length; j++) {
            if (title[j] === '(') level++
            if (title[j] === ')') level--
            if (level === 0) {
              break
            }
          }
          i = j
        } else {
          name += title[i]
        }
      }

      const artist = $('td').eq(2).text().trim()
      return { name: HTMLUnescape(name), artist: HTMLUnescape(artist) }
    })

  const spotifyTracks: SpotifyApi.TrackObjectFull[] = []
  const trackResults: ITrack[] = []

  for (const track of tracks) {
    if (SKIPPED_TRACKS.indexOf([track.artist, track.name]) !== -1) continue
    const spotifySearch = await spotify.searchTracks(
      `${track.name} ${track.artist}`,
      { limit: 1 }
    )
    if (
      spotifySearch.body.tracks?.items &&
      spotifySearch.body.tracks.items[0]
    ) {
      const spotifyTrack = spotifySearch.body.tracks.items[0]
      console.log(`${track.name} - ${track.artist} => ${spotifyTrack.uri}`)
      trackResults.push({ ...track, spotifyTrack })
      spotifyTracks.push(spotifyTrack)
    } else {
      console.error(`${track.name} - ${track.artist} => not found`)
      trackResults.push(track)
    }
  }

  if (spotifyTracks.length === 0) {
    console.log(`${title} => Skipping empty playlist`)
    return
  }

  const spotifyPlaylist = await spotify.createPlaylist(
    `${config.stationName} - ${title}`,
    {
      public: false,
    }
  )

  await spotify.changePlaylistDetails(spotifyPlaylist.body.id, {
    public: false,
  })
  console.log(
    `${title} => Created playlist ${config.stationName} - ${title} (${spotifyPlaylist.body.uri}), URL ${spotifyPlaylist.body.external_urls.spotify}`
  )

  await spotify.addTracksToPlaylist(
    spotifyPlaylist.body.id,
    spotifyTracks.map(({ uri }) => uri)
  )

  console.log(`${title} => added ${spotifyTracks.length} tracks to playlist`)

  if (bot && config.telegram) {
    let message = `New playlist [${spotifyPlaylist.body.name}](${spotifyPlaylist.body.external_urls.spotify}) added to Spotify.\n`

    for (const { artist, name, spotifyTrack } of trackResults) {
      message += `- ${artist}: ${name} => `
      if (spotifyTrack) {
        message += `${spotifyTrack.artists
          .map(({ name }) => name)
          .join(', ')}: ${spotifyTrack.name}\n`
      } else {
        message += '[Not found on Spotify]\n'
      }
    }

    await bot.telegram.sendMessage(config.telegram?.channel, message, {
      // eslint-disable-next-line camelcase
      parse_mode: 'Markdown',
    })
  }
}

/**
 * Main function
 */
const main = async () => {
  let config: IConfig
  let bot: Telegraf | undefined = undefined

  try {
    const _config = YAML.load(await fs.promises.readFile(CONFIG_PATH, 'utf8'))
    if (!_config) {
      throw new Error()
    }
    config = _config as IConfig

    if (!config.targetRadioStation) {
      console.error('No targetRadioStation specified')
      process.exit(1)
    }
    if (!config.spotify?.clientId) {
      console.error('No clientId specified')
      process.exit(1)
    }
    if (!config.spotify?.clientSecret) {
      console.error('No clientSecret specified')
      process.exit(1)
    }

    if (!config.stationName) config.stationName = config.targetRadioStation
    if (!config.OAuthHandlerPort) config.OAuthHandlerPort = 31208
    if (!config.lastVisited) config.lastVisited = 0
    if (!config.maxBulkImportSize) config.maxBulkImportSize = 10
  } catch (e) {
    console.error('No config file provided')
    process.exit(1)
  }

  if (config.telegram) {
    bot = new Telegraf(config.telegram.botToken)
  }

  const spotify = new Spotify({
    clientId: config.spotify.clientId,
    clientSecret: config.spotify.clientSecret,
    redirectUri: `http://localhost:${config.OAuthHandlerPort}/callback`,
  })

  if (!config.spotify.refreshToken) {
    const authURL = spotify.createAuthorizeURL(
      [
        'user-read-private',
        'playlist-modify-public',
        'playlist-modify-private',
        'playlist-read-private',
      ],
      ''
    )
    const code = await waitForOAuthRedirect(authURL, config.OAuthHandlerPort)
    const {
      body: { access_token: accessToken, refresh_token: refreshToken },
    } = await spotify.authorizationCodeGrant(code)
    spotify.setAccessToken(accessToken)
    spotify.setRefreshToken(refreshToken)
    config.spotify.refreshToken = refreshToken
  } else {
    spotify.setRefreshToken(config.spotify.refreshToken)
    const {
      body: { access_token: accessToken, refresh_token: newRefreshToken },
    } = await spotify.refreshAccessToken()
    spotify.setAccessToken(accessToken)
    if (newRefreshToken !== undefined)
      config.spotify.refreshToken = newRefreshToken
  }

  console.log('Connected to Spotify')
  await saveConfig(config)

  const listUrl = `https://miniweb.imbc.com/Music?page=1&progCode=${config.targetRadioStation}`
  console.log('Checking for new playlists at: ', listUrl)
  const programsResponse = await Axios.get(listUrl)
  const HTML = programsResponse.data
  const $ = cheerio.load(HTML)
  const rows = $('table.list-type tbody tr')
  const latestRow = rows.eq(0)

  const href = $(latestRow).find('a').eq(0).attr('href')
  if (!href) {
    console.log('Failed to parse HTML')
    process.exit(1)
  }

  const match = SEQ_ID_REGEX.exec(href)
  if (!match) {
    console.log('Failed to parse HTML')
    process.exit(1)
  }

  const seqID = parseInt(match[1])
  const targetIDs: number[] = []
  for (
    let i = 0;
    i < Math.min(seqID - config.lastVisited, config.maxBulkImportSize);
    i++
  ) {
    targetIDs.push(seqID - i)
  }

  if (targetIDs.length > 0) {
    console.log('found new targets', targetIDs)
    config.lastVisited = targetIDs[0]
  }

  for (const targetID of targetIDs) {
    await sleep(1)
    try {
      await createPlaylist(config, targetID, bot, spotify)
    } catch (e) {
      console.error(e)
    }
  }

  await saveConfig(config)
}

main()
