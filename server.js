const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match && process.env[match[1]] === undefined) {
      process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  }
}

const port = Number(process.env.PORT) || 3000;
const indexPath = path.join(__dirname, 'index.html');
const databasePath = path.join(__dirname, 'db.json');

function readDatabase() {
  try {
    const database = JSON.parse(fs.readFileSync(databasePath, 'utf8'));
    return database && database.searches && typeof database.searches === 'object'
      ? database
      : { searches: {} };
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error('db.json est illisible; une base vide sera créée.');
    }
    return { searches: {} };
  }
}

function saveSearch(title, movies) {
  const key = title.toLocaleLowerCase('fr-FR').replace(/\s+/g, ' ');
  const database = readDatabase();
  database.searches[key] = {
    title,
    savedAt: new Date().toISOString(),
    movies,
  };

  const temporaryPath = `${databasePath}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(database, null, 2)}\n`, 'utf8');
  fs.renameSync(temporaryPath, databasePath);
}

function sendJson(response, statusCode, data) {
  response.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(data));
}

async function searchOmdb(apiKey, title) {
  const queries = [title];
  if (/^spider\s*-?\s*man$/i.test(title.replace(/\s+/g, ' ').trim()) && !/^spider-man$/i.test(title)) {
    queries.push('Spider-Man');
  }

  const movies = new Map();
  for (const query of new Set(queries)) {
    let totalPages = 1;

    for (let page = 1; page <= totalPages; page += 1) {
      const params = new URLSearchParams({ apikey: apiKey, s: query, type: 'movie', page: String(page) });
      const omdbResponse = await fetch(`https://www.omdbapi.com/?${params}`, {
        signal: AbortSignal.timeout(15000),
      });
      const data = await omdbResponse.json();

      if (!omdbResponse.ok) throw new Error('Le service OMDb est indisponible. Réessaie dans un instant.');
      if (data.Response === 'False') {
        if (data.Error === 'Movie not found!') break;
        throw new Error(data.Error || 'OMDb a refusé la recherche.');
      }

      for (const movie of data.Search || []) {
        if (movie.imdbID) movies.set(movie.imdbID, movie);
      }

      totalPages = Math.min(100, Math.ceil(Number(data.totalResults || 0) / 10));
    }
  }

  return [...movies.values()];
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url, 'http://localhost');
  const pathname = url.pathname;

  if (request.method === 'GET' && pathname === '/api/search') {
    const title = url.searchParams.get('title')?.trim();
    const apiKey = process.env.OMDB_API_KEY;

    if (!title) {
      sendJson(response, 400, { error: 'Saisis un titre de film.' });
      return;
    }
    if (title.length > 200) {
      sendJson(response, 400, { error: 'Le titre est trop long.' });
      return;
    }

    const cacheKey = title.toLocaleLowerCase('fr-FR').replace(/\s+/g, ' ');
    const cachedSearch = readDatabase().searches[cacheKey];
    if (Array.isArray(cachedSearch?.movies) && cachedSearch.movies.length > 0) {
      sendJson(response, 200, {
        Search: cachedSearch.movies,
        totalResults: String(cachedSearch.movies.length),
        fromDatabase: true,
      });
      return;
    }

    if (!apiKey) {
      sendJson(response, 503, { error: 'La clé OMDb manque. Configure OMDB_API_KEY dans le fichier .env.' });
      return;
    }

    searchOmdb(apiKey, title)
      .then((movies) => {
        saveSearch(title, movies);
        sendJson(response, 200, { Search: movies, totalResults: String(movies.length) });
      })
      .catch((error) => {
        if (!response.headersSent) {
          const isOmdbCredentialError = /invalid api key|not configured/i.test(error.message);
          sendJson(response, isOmdbCredentialError ? 503 : 502, {
            error: isOmdbCredentialError
              ? 'La clé OMDb est invalide. Vérifie OMDB_API_KEY dans .env.'
              : error.name === 'TimeoutError'
                ? 'OMDb met trop de temps à répondre. Réessaie.'
                : error.message || 'Impossible de contacter OMDb. Vérifie ta connexion internet.',
          });
        }
      });
    return;
  }

  if (request.method !== 'GET' || (pathname !== '/' && pathname !== '/index.html')) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Page introuvable');
    return;
  }

  fs.readFile(indexPath, (error, content) => {
    if (error) {
      response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Impossible de charger la page');
      return;
    }

    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(content);
  });
});

server.listen(port, () => {
  console.log(`Serveur disponible sur http://localhost:${port}`);
});
