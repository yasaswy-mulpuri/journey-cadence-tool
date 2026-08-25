const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const initSqlJs = require('sql.js');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_PATH = path.join(__dirname, 'cadence.db');

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

let db;

// Initialize database
async function initDb() {
    const SQL = await initSqlJs();

    // Load existing DB or create new
    if (fs.existsSync(DB_PATH)) {
        const buffer = fs.readFileSync(DB_PATH);
        db = new SQL.Database(buffer);
    } else {
        db = new SQL.Database();
    }

    // Create tables
    db.run(`
        CREATE TABLE IF NOT EXISTS journeys (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            journey_name TEXT NOT NULL,
            campaign_id TEXT NOT NULL,
            country TEXT NOT NULL,
            sfmc_journey_name TEXT,
            total_audience INTEGER NOT NULL,
            volume_per_day INTEGER NOT NULL,
            start_date TEXT NOT NULL,
            end_date TEXT NOT NULL,
            excluded_days TEXT,
            excluded_dates TEXT,
            status TEXT NOT NULL DEFAULT 'active',
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS journey_versions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            journey_id INTEGER NOT NULL,
            version_number INTEGER NOT NULL,
            version_label TEXT NOT NULL,
            status TEXT NOT NULL,
            email_configs TEXT NOT NULL,
            cadence_data TEXT NOT NULL,
            sfmc_data TEXT,
            notes TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            FOREIGN KEY (journey_id) REFERENCES journeys(id)
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS daily_cadence (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            journey_id INTEGER NOT NULL,
            version_id INTEGER NOT NULL,
            date TEXT NOT NULL,
            day_number INTEGER,
            email_name TEXT NOT NULL,
            email_type TEXT NOT NULL,
            volume INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL DEFAULT 'active',
            is_from_sfmc INTEGER NOT NULL DEFAULT 0,
            FOREIGN KEY (journey_id) REFERENCES journeys(id),
            FOREIGN KEY (version_id) REFERENCES journey_versions(id)
        )
    `);

    // Indexes for fast queries
    db.run(`CREATE INDEX IF NOT EXISTS idx_journeys_campaign ON journeys(campaign_id)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_journeys_country ON journeys(country)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_journeys_status ON journeys(status)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_daily_date ON daily_cadence(date)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_daily_journey ON daily_cadence(journey_id)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_versions_journey ON journey_versions(journey_id)`);

    saveDb();
    console.log('Database initialized');
}

function saveDb() {
    const data = db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(DB_PATH, buffer);
}

// ============ API ROUTES ============

// --- Journeys ---

// List all journeys (with latest version info)
app.get('/api/journeys', (req, res) => {
    const { campaign_id, country, status } = req.query;
    let sql = `SELECT j.*, 
        (SELECT MAX(version_number) FROM journey_versions WHERE journey_id = j.id) as latest_version,
        (SELECT COUNT(*) FROM journey_versions WHERE journey_id = j.id) as total_versions
        FROM journeys j WHERE 1=1`;
    const params = [];

    if (campaign_id) { sql += ` AND j.campaign_id = ?`; params.push(campaign_id); }
    if (country) { sql += ` AND j.country = ?`; params.push(country.toUpperCase()); }
    if (status) { sql += ` AND j.status = ?`; params.push(status); }

    sql += ` ORDER BY j.updated_at DESC`;

    const results = db.exec(sql, params);
    const journeys = resultToObjects(results);
    res.json(journeys);
});

// Get single journey with all versions
app.get('/api/journeys/:id', (req, res) => {
    const results = db.exec('SELECT * FROM journeys WHERE id = ?', [req.params.id]);
    const journey = resultToObjects(results);
    if (journey.length === 0) return res.status(404).json({ error: 'Journey not found' });

    const versions = db.exec(
        'SELECT * FROM journey_versions WHERE journey_id = ? ORDER BY version_number DESC',
        [req.params.id]
    );

    res.json({
        ...journey[0],
        versions: resultToObjects(versions)
    });
});

// Save a new journey (or new version of existing journey)
app.post('/api/journeys', (req, res) => {
    const {
        journey_name, campaign_id, country, sfmc_journey_name,
        total_audience, volume_per_day, start_date, end_date,
        excluded_days, excluded_dates, status,
        email_configs, cadence_data, sfmc_data, notes
    } = req.body;

    if (!journey_name || !campaign_id || !total_audience || !volume_per_day || !start_date) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    // Extract country from campaign_id if not provided
    const resolvedCountry = (country || campaign_id.split('-')[0] || '').toUpperCase().slice(0, 2);

    // Check if journey already exists
    const existing = db.exec('SELECT id FROM journeys WHERE journey_name = ?', [journey_name]);
    const existingJourneys = resultToObjects(existing);

    let journeyId;

    if (existingJourneys.length > 0) {
        // Update existing journey
        journeyId = existingJourneys[0].id;
        db.run(`UPDATE journeys SET 
            campaign_id = ?, country = ?, sfmc_journey_name = ?,
            total_audience = ?, volume_per_day = ?, start_date = ?, end_date = ?,
            excluded_days = ?, excluded_dates = ?, status = ?, updated_at = datetime('now')
            WHERE id = ?`, [
            campaign_id, resolvedCountry, sfmc_journey_name || '',
            total_audience, volume_per_day, start_date, end_date,
            excluded_days || '', excluded_dates || '', status || 'active',
            journeyId
        ]);
    } else {
        // Create new journey
        db.run(`INSERT INTO journeys (journey_name, campaign_id, country, sfmc_journey_name,
            total_audience, volume_per_day, start_date, end_date,
            excluded_days, excluded_dates, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
            journey_name, campaign_id, resolvedCountry, sfmc_journey_name || '',
            total_audience, volume_per_day, start_date, end_date,
            excluded_days || '', excluded_dates || '', status || 'active'
        ]);

        const newId = db.exec('SELECT last_insert_rowid() as id');
        journeyId = resultToObjects(newId)[0].id;
    }

    // Get next version number
    const versionResult = db.exec(
        'SELECT COALESCE(MAX(version_number), 0) + 1 as next_version FROM journey_versions WHERE journey_id = ?',
        [journeyId]
    );
    const nextVersion = resultToObjects(versionResult)[0].next_version;

    // Create version label with timestamp
    const now = new Date();
    const timestamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const versionLabel = `v${nextVersion}_${timestamp}_${status || 'active'}`;

    // Save version
    db.run(`INSERT INTO journey_versions (journey_id, version_number, version_label, status, 
        email_configs, cadence_data, sfmc_data, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [
        journeyId, nextVersion, versionLabel, status || 'active',
        JSON.stringify(email_configs), JSON.stringify(cadence_data),
        sfmc_data ? JSON.stringify(sfmc_data) : null, notes || ''
    ]);

    const versionIdResult = db.exec('SELECT last_insert_rowid() as id');
    const versionId = resultToObjects(versionIdResult)[0].id;

    // Save daily cadence data
    if (cadence_data && Array.isArray(cadence_data)) {
        const insertStmt = db.prepare(`INSERT INTO daily_cadence 
            (journey_id, version_id, date, day_number, email_name, email_type, volume, status, is_from_sfmc)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);

        cadence_data.forEach(day => {
            if (day.emails && day.emails.length > 0) {
                day.emails.forEach(email => {
                    insertStmt.run([
                        journeyId, versionId, day.dateStr,
                        day.dayNumber === '-' ? null : day.dayNumber,
                        email.name,
                        email.condition === 'none' ? 'main' : 'reminder',
                        email.volume || 0,
                        day.paused ? 'paused' : day.excluded ? 'excluded' : 'active',
                        email.isFromSfmc ? 1 : 0
                    ]);
                });
            }
        });
        insertStmt.free();
    }

    saveDb();

    res.json({
        success: true,
        journey_id: journeyId,
        version_id: versionId,
        version_number: nextVersion,
        version_label: versionLabel
    });
});

// Update journey status
app.patch('/api/journeys/:id/status', (req, res) => {
    const { status } = req.body;
    if (!['active', 'paused', 'stopped'].includes(status)) {
        return res.status(400).json({ error: 'Invalid status. Use: active, paused, stopped' });
    }

    db.run('UPDATE journeys SET status = ?, updated_at = datetime(\'now\') WHERE id = ?',
        [status, req.params.id]);
    saveDb();

    res.json({ success: true, status });
});

// Get specific version cadence
app.get('/api/journeys/:id/versions/:versionId', (req, res) => {
    const results = db.exec(
        'SELECT * FROM journey_versions WHERE id = ? AND journey_id = ?',
        [req.params.versionId, req.params.id]
    );
    const versions = resultToObjects(results);
    if (versions.length === 0) return res.status(404).json({ error: 'Version not found' });

    const version = versions[0];
    version.email_configs = JSON.parse(version.email_configs);
    version.cadence_data = JSON.parse(version.cadence_data);
    if (version.sfmc_data) version.sfmc_data = JSON.parse(version.sfmc_data);

    res.json(version);
});

// --- Business View API ---

// Get aggregated daily volumes for a campaign/country/date range
app.get('/api/business/calendar', (req, res) => {
    const { campaign_id, country, start_date, end_date } = req.query;

    if (!campaign_id && !country) {
        return res.status(400).json({ error: 'Provide at least campaign_id or country' });
    }

    // Get the latest version ID for each journey
    let journeySql = `SELECT j.id, j.journey_name, j.campaign_id, j.country, j.status,
        (SELECT MAX(jv.id) FROM journey_versions jv WHERE jv.journey_id = j.id) as latest_version_id
        FROM journeys j WHERE 1=1`;
    const jParams = [];

    if (campaign_id) { journeySql += ` AND j.campaign_id = ?`; jParams.push(campaign_id); }
    if (country) { journeySql += ` AND j.country = ?`; jParams.push(country.toUpperCase()); }

    const journeyResults = db.exec(journeySql, jParams);
    const journeys = resultToObjects(journeyResults);

    if (journeys.length === 0) {
        return res.json({ journeys: [], calendar: [] });
    }

    // Get daily cadence for each journey's latest version
    const versionIds = journeys.map(j => j.latest_version_id).filter(v => v);
    if (versionIds.length === 0) {
        return res.json({ journeys, calendar: [] });
    }

    let dailySql = `SELECT dc.*, j.journey_name, j.campaign_id, j.status as journey_status
        FROM daily_cadence dc
        JOIN journeys j ON dc.journey_id = j.id
        WHERE dc.version_id IN (${versionIds.map(() => '?').join(',')})
        AND dc.status = 'active'`;
    const dParams = [...versionIds];

    if (start_date) { dailySql += ` AND dc.date >= ?`; dParams.push(start_date); }
    if (end_date) { dailySql += ` AND dc.date <= ?`; dParams.push(end_date); }

    dailySql += ` ORDER BY dc.date, dc.journey_id`;

    const dailyResults = db.exec(dailySql, dParams);
    const dailyData = resultToObjects(dailyResults);

    // Group by date
    const calendarMap = {};
    dailyData.forEach(row => {
        if (!calendarMap[row.date]) {
            calendarMap[row.date] = { date: row.date, entries: [], totalVolume: 0, totalMain: 0, totalReminder: 0 };
        }
        calendarMap[row.date].entries.push(row);
        calendarMap[row.date].totalVolume += row.volume;
        if (row.email_type === 'main') {
            calendarMap[row.date].totalMain += row.volume;
        } else {
            calendarMap[row.date].totalReminder += row.volume;
        }
    });

    const calendar = Object.values(calendarMap).sort((a, b) => a.date.localeCompare(b.date));

    res.json({ journeys, calendar });
});

// Get list of unique campaign IDs
app.get('/api/campaigns', (req, res) => {
    const results = db.exec('SELECT DISTINCT campaign_id, country FROM journeys ORDER BY campaign_id');
    res.json(resultToObjects(results));
});

// Get list of unique countries
app.get('/api/countries', (req, res) => {
    const results = db.exec('SELECT DISTINCT country FROM journeys ORDER BY country');
    res.json(resultToObjects(results));
});

// Delete a journey
app.delete('/api/journeys/:id', (req, res) => {
    db.run('DELETE FROM daily_cadence WHERE journey_id = ?', [req.params.id]);
    db.run('DELETE FROM journey_versions WHERE journey_id = ?', [req.params.id]);
    db.run('DELETE FROM journeys WHERE id = ?', [req.params.id]);
    saveDb();
    res.json({ success: true });
});

// --- Helper ---
function resultToObjects(results) {
    if (!results || results.length === 0) return [];
    const { columns, values } = results[0];
    return values.map(row => {
        const obj = {};
        columns.forEach((col, i) => { obj[col] = row[i]; });
        return obj;
    });
}

// --- Serve HTML pages ---
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'developer.html'));
});

app.get('/business', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'business.html'));
});

// Start server
initDb().then(() => {
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`Journey Cadence Tool running at http://localhost:${PORT}`);
        console.log(`  Developer View: http://localhost:${PORT}/`);
        console.log(`  Business View:  http://localhost:${PORT}/business`);
    });
}).catch(err => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
});
