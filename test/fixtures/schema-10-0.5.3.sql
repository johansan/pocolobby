-- Written by package 0.5.3 (commit b119c89) through test/fixtures/generate-schema-10.mjs,
-- starting from schema-8-0.4.0.sql, its default lobby renamed my-team. Do not edit by hand.
PRAGMA foreign_keys=OFF;
BEGIN TRANSACTION;
CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO metadata VALUES('incarnation','b5a48595-0eac-41d3-93bd-e4e140d3ca06');
CREATE TABLE agents (
        agent_id TEXT PRIMARY KEY, token_hash TEXT UNIQUE, role TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1, paused INTEGER NOT NULL DEFAULT 0,
        can_broadcast INTEGER NOT NULL, allowed_recipients TEXT,
        runtime_id TEXT, generation INTEGER NOT NULL DEFAULT 0, ready INTEGER NOT NULL DEFAULT 0,
        probe_nonce TEXT NOT NULL, bootstrap_attempts INTEGER NOT NULL DEFAULT 0,
        bootstrap_next_at INTEGER NOT NULL DEFAULT 0, backlog_sequence INTEGER NOT NULL DEFAULT 0,
        last_seen_at TEXT, last_agent_seen_at TEXT, receipt_seq INTEGER NOT NULL DEFAULT 0
      , lobby_id TEXT NOT NULL DEFAULT 'my-team' REFERENCES lobbies(lobby_id), manage_rooms INTEGER NOT NULL DEFAULT 0, status_state TEXT
        CHECK (status_state IS NULL OR status_state IN ('working','idle','blocked','away')), status_text TEXT, status_set_at TEXT, backlog_at INTEGER NOT NULL DEFAULT 0);
INSERT INTO agents VALUES('my-team/vader','fb282b2148296bf73a1bd3390250194221086ff69087b068af36248e8d726479','vader role',1,0,1,NULL,'00000000-0000-4000-8000-000000000005',1,1,'c1303005-201b-47d3-8bb9-c2e93fe5786d',0,1792065611000,0,'2026-10-15T12:00:39.000Z','2026-10-15T12:00:12.000Z',0,'my-team',1,'working','Board check','2026-10-16T05:00:26.000Z',0);
INSERT INTO agents VALUES('my-team/luke','bc8f6ed7a1a9c1788acace77acd1b739c18917eb3224650eccf872e53d560888','luke role',1,0,0,NULL,'00000000-0000-4000-8000-000000000004',1,1,'4637fc9e-e080-4b43-9a3d-5927047df608',0,1792065613000,0,NULL,'2026-10-15T20:00:13.000Z',3,'my-team',0,'idle',NULL,'2026-10-16T03:00:05.000Z',0);
INSERT INTO agents VALUES('my-team/lando','23841aef0231fd05ccc836a418bc66a40539c1dd56f0074c47f6e37ab2580525','lando role',1,0,0,NULL,NULL,0,0,'7121daee-75a6-4763-9b64-38579ea0cb49',0,0,0,NULL,NULL,0,'my-team',0,NULL,NULL,NULL,0);
INSERT INTO agents VALUES('my-team/padme','b62a1ea2219608c0e797534deb368e0a93183f80deb30c18531b675273b0de10','padme role',1,0,0,NULL,'00000000-0000-4000-8000-000000000006',1,1,'d71f2ffc-8fc6-489a-8acf-a7d72c998a49',0,1792137639000,21,NULL,'2026-10-16T08:00:57.000Z',1,'my-team',0,'working','Release plan','2026-10-16T08:00:45.000Z',1792137640000);
CREATE TABLE runtime_history (
        agent_id TEXT NOT NULL REFERENCES agents(agent_id), runtime_id TEXT NOT NULL,
        PRIMARY KEY (agent_id, runtime_id)
      );
INSERT INTO runtime_history VALUES('my-team/vader','00000000-0000-4000-8000-000000000005');
INSERT INTO runtime_history VALUES('my-team/luke','00000000-0000-4000-8000-000000000004');
INSERT INTO runtime_history VALUES('my-team/padme','00000000-0000-4000-8000-000000000006');
CREATE TABLE messages (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
        sender TEXT NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
        target TEXT NOT NULL, priority TEXT NOT NULL, content TEXT NOT NULL,
        correlation_id TEXT, reply_to TEXT, created_at TEXT NOT NULL, created_ms INTEGER NOT NULL,
        byte_size INTEGER NOT NULL, lobby_id TEXT NOT NULL DEFAULT 'my-team' REFERENCES lobbies(lobby_id), room_id TEXT, details TEXT, notify_when_seen INTEGER NOT NULL DEFAULT 0, deliver_at_ms INTEGER, released_ms INTEGER, late INTEGER NOT NULL DEFAULT 0, cancelled_at TEXT, schedule_id TEXT, kind TEXT
        CHECK (kind IS NULL OR kind IN ('request','notice','assignment','report','question')), reply_expected INTEGER
        CHECK (reply_expected IS NULL OR reply_expected IN (0,1)), UNIQUE (sender, request_id)
      );
INSERT INTO messages VALUES(1,'f185fe41-32b2-45c0-89c2-3b492efef539','my-team/vader','fixture-assignment','da1b77e715ec15227689c26a60d4c5bb7323faf0d9c83b3d00db39d91be6fda1','luke','important','Review the login fix','login-42',NULL,'2026-10-15T12:00:17.000Z',1792065617000,20,'my-team',NULL,NULL,0,NULL,NULL,0,NULL,NULL,NULL,NULL);
INSERT INTO messages VALUES(2,'eef99ba1-7367-4839-bcce-63a547050e7e','my-team/vader','fixture-room','06b59e0140fc1481d74524bbffe8f8930d2889499bcb8be430f6bcb73cae5042','*','info','App standup at 10',NULL,NULL,'2026-10-15T12:00:26.000Z',1792065626000,17,'my-team','app',NULL,0,NULL,NULL,0,NULL,NULL,NULL,NULL);
INSERT INTO messages VALUES(3,'51f36e52-b56c-4be9-bc51-8fc1658f2cca','my-team/owner','fixture-owner-note','ee184b47c40bb591f7fc9fbbd32022d86aed25d9e430370d485d9277bbf6d7db','lando','info','Welcome',NULL,NULL,'2026-10-15T12:00:28.000Z',1792065628000,7,'my-team',NULL,NULL,0,NULL,NULL,0,NULL,NULL,NULL,NULL);
INSERT INTO messages VALUES(4,'f5119933-9308-46d8-9dcc-7ba7d129589f','my-team/vader','fixture-self','e7639014895f16d247ccde1b1377bc7be685413d90556a86029dbddedb6f6aa3','vader','info','Note to self',NULL,NULL,'2026-10-15T12:00:31.000Z',1792065631000,12,'my-team',NULL,NULL,0,NULL,NULL,0,NULL,NULL,NULL,NULL);
INSERT INTO messages VALUES(5,'854ae7cc-a3f7-4c84-b0cf-02e368c0489b','my-team/vader','fixture-broadcast','afdabd948b9b934db67dfd382318a2cffcaa3f63742d55f9d048095228bdda6b','*','info','Lobby news',NULL,NULL,'2026-10-15T12:00:34.000Z',1792065634000,10,'my-team',NULL,NULL,0,NULL,NULL,0,NULL,NULL,NULL,NULL);
INSERT INTO messages VALUES(6,'c5c55c62-1749-4f2d-8a87-144682c5b114','my-team/vader','fixture-013-notice','acf97598db26dca037987def81cb4e4e95518295c2faffd880c6531f3b17609f','luke','info','FYI: the build is green',NULL,NULL,'2026-10-15T13:00:02.000Z',1792069202000,23,'my-team',NULL,NULL,0,NULL,NULL,0,NULL,NULL,'notice',0);
INSERT INTO messages VALUES(7,'b0353ef8-d91c-4fa9-b027-6e9e05285600','my-team/vader','fixture-013-assignment','1ab502bbb9a8dea66575d604db8b0511c5f001bd4684aa4998163e5c1e14a6f6','luke','info','Fix the login bug',NULL,NULL,'2026-10-15T13:00:04.000Z',1792069204000,62,'my-team',NULL,'{"commit":"abc1234","files":["src/login.ts"]}',1,NULL,NULL,0,NULL,NULL,'assignment',1);
INSERT INTO messages VALUES(8,'9d0502ec-ae38-4563-9e02-5983fe11da4c','my-team/vader','fixture-013-default','0b22acf4e51787b367df21bf42985d4d41a9b85b5f27d7ea3d84ef51d9456272','luke','info','Sent without a kind through 0.1.3',NULL,NULL,'2026-10-15T13:00:06.000Z',1792069206000,33,'my-team',NULL,NULL,0,NULL,NULL,0,NULL,NULL,NULL,NULL);
INSERT INTO messages VALUES(9,'dc4b19ae-7ddd-4822-af50-06a99181b66f','my-team/vader','fixture-013-explicit-request','ffed3f8c636dcea7989053e14e8fe248911aeb61bd9f6548496fcae04fb53f49','luke','info','Please review PR 12',NULL,NULL,'2026-10-15T13:00:08.000Z',1792069208000,19,'my-team',NULL,NULL,0,NULL,NULL,0,NULL,NULL,NULL,NULL);
INSERT INTO messages VALUES(10,'42713506-1e6f-4c91-971f-caae9f0aaa45','my-team/vader','fixture-013-no-reply','39078f43d54b46264df6ad1f2fcd8269802a731c3d81446dfc3caa09656eceac','luke','info','No kind, no reply wanted',NULL,NULL,'2026-10-15T13:00:10.000Z',1792069210000,24,'my-team',NULL,NULL,0,NULL,NULL,0,NULL,NULL,NULL,0);
INSERT INTO messages VALUES(11,'fde14eb0-dc22-4ede-8fd0-ca8cb422b7f8','my-team/vader','fixture-013-question','ac607761dcebff4ed8b242e0d5eaa95ddcc4828dbc0710b26d4a209a75137742','luke','info','Which release day?',NULL,NULL,'2026-10-15T13:00:12.000Z',1792069212000,80,'my-team',NULL,'{"options":["Tuesday","Thursday"],"recommendation":"Thursday"}',0,NULL,NULL,0,NULL,NULL,'question',1);
INSERT INTO messages VALUES(12,'7255fd44-08f3-490a-a3ce-7f1ff688e932','my-team/vader','fixture-013-reminder','3b1cbe1ee976f185db12f2668b96bd937f1d001505e75cedc197d135fdd286a6','vader','info','Check the overnight reports',NULL,NULL,'2026-10-15T13:00:14.000Z',1792069214000,27,'my-team',NULL,NULL,0,1793511660000,NULL,0,NULL,NULL,'notice',0);
INSERT INTO messages VALUES(13,'4e837b7c-4540-4332-b46f-6250e72448d4','my-team/vader','fixture-020-report','0fb82e40adbdcbd8f216af0bec8915b2db5eb0eb054381482a171ea15da73651','luke','info',unistr('Research report\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a| row | value |\u000a'),NULL,NULL,'2026-10-15T20:00:02.000Z',1792094402000,19264,'my-team',NULL,'{"evidence":"dropbox:MDP/reports/2026-10-15.md"}',0,NULL,NULL,0,NULL,NULL,'report',0);
INSERT INTO messages VALUES(14,'c4da0312-6b4a-482f-b6ca-42636ee39b83','my-team/vader','fixture-020-plain','6a248c89026d5a8aa128cf263e49291f54d7a34150ce9e2754564754bb5d0042','luke','info','Sent without a kind through 0.2.0',NULL,NULL,'2026-10-15T20:00:04.000Z',1792094404000,33,'my-team',NULL,NULL,0,NULL,NULL,0,NULL,NULL,NULL,NULL);
INSERT INTO messages VALUES(15,'1822c8f7-4677-4136-8721-0e007725cab2','my-team/vader','fixture-020-notice','3c4f29f3328e19114015ad319e8d84aaa187725442a40c46947ed9f8e691de98','luke','info','Screenshot is at dropbox:MDP/screens/before.png',NULL,NULL,'2026-10-15T20:00:06.000Z',1792094406000,47,'my-team',NULL,NULL,1,NULL,NULL,0,NULL,NULL,'notice',0);
INSERT INTO messages VALUES(16,'51fccb3e-4c4d-4ce6-9ae7-7ac8a6d354c9','my-team/vader','fixture-020-reminder','03aa1ea76e880cc606cd6bd315b57bdab16e96de42e6729bc51b12afce4ba368','vader','info','Review the screenshots',NULL,NULL,'2026-10-15T20:00:08.000Z',1792094408000,22,'my-team',NULL,NULL,0,1793598060000,NULL,0,NULL,NULL,'notice',0);
INSERT INTO messages VALUES(17,'573b569b-648f-46f8-8dbe-65c1f3ba13d5','my-team/vader','fixture-031-assignment','d69236cf385558555cdd631232e3b408613112e7d62a107d125451937804e302','luke','info','Film the 3D deck for the site',NULL,NULL,'2026-10-16T03:00:09.000Z',1792119609000,29,'my-team',NULL,NULL,0,NULL,NULL,0,NULL,NULL,'assignment',1);
INSERT INTO messages VALUES(18,'e154bf03-5627-4bc3-bb06-70846fc4afd0','my-team/luke','fixture-031-report','d934c0889ed6a9eac38e7bc603ac266374663e7b679d1145573ff091350385ca','vader','info','Filmed the 3D deck',NULL,NULL,'2026-10-16T03:00:12.000Z',1792119612000,40,'my-team',NULL,'{"commit":"8e560f0e9"}',0,NULL,NULL,0,NULL,NULL,'report',0);
INSERT INTO messages VALUES(19,'8af594e5-868a-4ff3-bfa4-04d84e14f4c3','my-team/vader','fixture-031-room','accf2f9d1a3a6400a7961fd2f67a65933161d5933358b58e9afd1c7ed37713f0','*','info','Main is green',NULL,NULL,'2026-10-16T03:00:15.000Z',1792119615000,13,'my-team','app',NULL,0,NULL,NULL,0,NULL,NULL,'notice',0);
INSERT INTO messages VALUES(20,'7ddb54cd-0381-4459-a81f-1f5c267e35e8','my-team/luke','fixture-031-attachment','07bf1abdc50271084daaa52607e61a0995e445caf80b81c658b49573b0d3cbf4','vader','info','Before frame attached',NULL,NULL,'2026-10-16T03:00:19.000Z',1792119619000,21,'my-team',NULL,NULL,0,NULL,NULL,0,NULL,NULL,'report',0);
INSERT INTO messages VALUES(21,'5895114f-0f7c-47bf-afc7-f7cdcb20f828','my-team/vader','fixture-040-night','9721eeb0b82cf3849efa82725645643cacf6b0aaf3399709c2837b8e59a18f89','*','info','Night test starts',NULL,NULL,'2026-10-16T05:00:10.000Z',1792126810000,17,'my-team','night-test',NULL,0,NULL,NULL,0,NULL,NULL,'notice',0);
INSERT INTO messages VALUES(22,'70e60908-ec36-4970-af03-6ad60dcd409a','my-team/vader','fixture-053-assignment','a70fe71145dfcea520d99d898625541e27c3d7e05844f1c8bddd9cc63264a149','padme','info','Plan the 0.6.0 release',NULL,NULL,'2026-10-16T08:00:49.000Z',1792137649000,22,'my-team',NULL,NULL,1,NULL,NULL,0,NULL,NULL,'assignment',1);
INSERT INTO messages VALUES(23,'048333bf-9923-4659-9d01-2f110e47f80d','my-team/vader','fixture-053-room','6b52b4749dfca3d16c12060a67e94ca5f91998c939fd67edd93b3f104dd644f9','*','info','Padmé joins the app room',NULL,NULL,'2026-10-16T08:01:01.000Z',1792137661000,25,'my-team','app',NULL,0,NULL,NULL,0,NULL,NULL,'notice',0);
INSERT INTO messages VALUES(24,'6cec4d99-e0f1-4ec8-9451-1a07d9c7e5bb','my-team/luke','fixture-053-pending','5ee1baa4292976c93fdde3e0fc9f3cff3587cb58c777852bb9f958b279061486','padme','info','Which day is the release?',NULL,NULL,'2026-10-16T08:01:08.000Z',1792137668000,57,'my-team',NULL,'{"options":["Monday","Tuesday"]}',0,NULL,NULL,0,NULL,NULL,'question',1);
INSERT INTO messages VALUES(25,'3f8420f5-a367-4e43-877a-af7b5090b2c2','my-team/vader','fixture-053-scheduled','eed6113c0f8619a20580a39867788bb971783420c78d26ef2400874b60ac5879','luke','info','Release day',NULL,NULL,'2026-10-16T08:01:11.000Z',1792137671000,11,'my-team',NULL,NULL,0,1792310400000,NULL,0,NULL,NULL,'notice',0);
INSERT INTO messages VALUES(26,'99f5cc0e-523c-4c28-bb75-1c845440b570','my-team/padme','fixture-053-attachment','fb62ac1c4af714260f0da48730e52fc4868afeee11a1f24b28408dab979ebe05','vader','info','Release plan attached',NULL,NULL,'2026-10-16T08:01:19.000Z',1792137679000,21,'my-team',NULL,NULL,0,NULL,NULL,0,NULL,NULL,'report',0);
CREATE TABLE deliveries (
        message_id TEXT NOT NULL REFERENCES messages(id), agent_id TEXT NOT NULL REFERENCES agents(agent_id),
        seen_at TEXT, receipt_seq INTEGER, attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL, last_notification_id TEXT, held_reason TEXT, notification_attempted_at TEXT,
        PRIMARY KEY (message_id, agent_id), UNIQUE (agent_id, receipt_seq)
      );
INSERT INTO deliveries VALUES('f185fe41-32b2-45c0-89c2-3b492efef539','my-team/luke','2026-10-15T12:00:22.000Z',1,1,1792065648000,'cf88a4b1-904c-43ac-8570-8017d265f807',NULL,'2026-10-15T12:00:21.000Z');
INSERT INTO deliveries VALUES('eef99ba1-7367-4839-bcce-63a547050e7e','my-team/luke',NULL,NULL,0,1792065626000,NULL,NULL,NULL);
INSERT INTO deliveries VALUES('51f36e52-b56c-4be9-bc51-8fc1658f2cca','my-team/lando',NULL,NULL,0,1792065628000,NULL,NULL,NULL);
INSERT INTO deliveries VALUES('f5119933-9308-46d8-9dcc-7ba7d129589f','my-team/vader',NULL,NULL,0,1792065631000,NULL,NULL,NULL);
INSERT INTO deliveries VALUES('854ae7cc-a3f7-4c84-b0cf-02e368c0489b','my-team/lando',NULL,NULL,0,1792065634000,NULL,NULL,NULL);
INSERT INTO deliveries VALUES('854ae7cc-a3f7-4c84-b0cf-02e368c0489b','my-team/luke',NULL,NULL,0,1792065634000,NULL,NULL,NULL);
INSERT INTO deliveries VALUES('c5c55c62-1749-4f2d-8a87-144682c5b114','my-team/luke',NULL,NULL,0,1792069202000,NULL,NULL,NULL);
INSERT INTO deliveries VALUES('b0353ef8-d91c-4fa9-b027-6e9e05285600','my-team/luke','2026-10-15T13:00:19.000Z',2,0,1792069204000,NULL,NULL,NULL);
INSERT INTO deliveries VALUES('9d0502ec-ae38-4563-9e02-5983fe11da4c','my-team/luke',NULL,NULL,0,1792069206000,NULL,NULL,NULL);
INSERT INTO deliveries VALUES('dc4b19ae-7ddd-4822-af50-06a99181b66f','my-team/luke',NULL,NULL,0,1792069208000,NULL,NULL,NULL);
INSERT INTO deliveries VALUES('42713506-1e6f-4c91-971f-caae9f0aaa45','my-team/luke',NULL,NULL,0,1792069210000,NULL,NULL,NULL);
INSERT INTO deliveries VALUES('fde14eb0-dc22-4ede-8fd0-ca8cb422b7f8','my-team/luke',NULL,NULL,0,1792069212000,NULL,NULL,NULL);
INSERT INTO deliveries VALUES('7255fd44-08f3-490a-a3ce-7f1ff688e932','my-team/vader',NULL,NULL,0,1793511660000,NULL,'scheduled',NULL);
INSERT INTO deliveries VALUES('4e837b7c-4540-4332-b46f-6250e72448d4','my-team/luke',NULL,NULL,0,1792094402000,NULL,NULL,NULL);
INSERT INTO deliveries VALUES('c4da0312-6b4a-482f-b6ca-42636ee39b83','my-team/luke',NULL,NULL,0,1792094404000,NULL,NULL,NULL);
INSERT INTO deliveries VALUES('1822c8f7-4677-4136-8721-0e007725cab2','my-team/luke','2026-10-15T20:00:11.000Z',3,0,1792094406000,NULL,NULL,NULL);
INSERT INTO deliveries VALUES('51fccb3e-4c4d-4ce6-9ae7-7ac8a6d354c9','my-team/vader',NULL,NULL,0,1793598060000,NULL,'scheduled',NULL);
INSERT INTO deliveries VALUES('573b569b-648f-46f8-8dbe-65c1f3ba13d5','my-team/luke',NULL,NULL,0,1792119609000,NULL,NULL,NULL);
INSERT INTO deliveries VALUES('e154bf03-5627-4bc3-bb06-70846fc4afd0','my-team/vader',NULL,NULL,0,1792119612000,NULL,NULL,NULL);
INSERT INTO deliveries VALUES('8af594e5-868a-4ff3-bfa4-04d84e14f4c3','my-team/luke',NULL,NULL,0,1792119615000,NULL,NULL,NULL);
INSERT INTO deliveries VALUES('7ddb54cd-0381-4459-a81f-1f5c267e35e8','my-team/vader',NULL,NULL,0,1792119619000,NULL,NULL,NULL);
INSERT INTO deliveries VALUES('5895114f-0f7c-47bf-afc7-f7cdcb20f828','my-team/luke',NULL,NULL,0,1792126810000,NULL,'room_deleted',NULL);
INSERT INTO deliveries VALUES('70e60908-ec36-4970-af03-6ad60dcd409a','my-team/padme','2026-10-16T08:00:54.000Z',1,1,1792137680000,'777fac9c-0add-4227-a05d-29ad0d8e4c32',NULL,'2026-10-16T08:00:53.000Z');
INSERT INTO deliveries VALUES('048333bf-9923-4659-9d01-2f110e47f80d','my-team/luke',NULL,NULL,0,1792137661000,NULL,NULL,NULL);
INSERT INTO deliveries VALUES('048333bf-9923-4659-9d01-2f110e47f80d','my-team/padme',NULL,NULL,1,1792137692000,'60e12c8b-5046-427d-a718-d77383873fa4',NULL,'2026-10-16T08:01:05.000Z');
INSERT INTO deliveries VALUES('6cec4d99-e0f1-4ec8-9451-1a07d9c7e5bb','my-team/padme',NULL,NULL,0,1792137668000,NULL,NULL,NULL);
INSERT INTO deliveries VALUES('3f8420f5-a367-4e43-877a-af7b5090b2c2','my-team/luke',NULL,NULL,0,1792310400000,NULL,'scheduled',NULL);
INSERT INTO deliveries VALUES('99f5cc0e-523c-4c28-bb75-1c845440b570','my-team/vader',NULL,NULL,0,1792137679000,NULL,NULL,NULL);
CREATE TABLE checkpoints (
        agent_id TEXT PRIMARY KEY REFERENCES agents(agent_id), revision INTEGER NOT NULL DEFAULT 0,
        content TEXT NOT NULL DEFAULT '', covered_receipt_seq INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT, runtime_id TEXT
      );
INSERT INTO checkpoints VALUES('my-team/vader',0,'',0,NULL,NULL);
INSERT INTO checkpoints VALUES('my-team/luke',1,'Login fix reviewed; standup pending.',1,'2026-10-15T12:00:38.000Z','00000000-0000-4000-8000-000000000004');
INSERT INTO checkpoints VALUES('my-team/lando',0,'',0,NULL,NULL);
INSERT INTO checkpoints VALUES('my-team/padme',1,'Release plan started.',1,'2026-10-16T08:00:58.000Z','00000000-0000-4000-8000-000000000006');
CREATE TABLE notification_attempts (
        id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(agent_id), runtime_id TEXT NOT NULL,
        generation INTEGER NOT NULL, incarnation TEXT NOT NULL, kind TEXT NOT NULL, created_at TEXT NOT NULL,
        adapter_received_at TEXT, notification_attempted_at TEXT
      );
INSERT INTO notification_attempts VALUES('cf88a4b1-904c-43ac-8570-8017d265f807','my-team/luke','00000000-0000-4000-8000-000000000004',1,'b5a48595-0eac-41d3-93bd-e4e140d3ca06','inbox','2026-10-15T12:00:19.000Z','2026-10-15T12:00:20.000Z','2026-10-15T12:00:21.000Z');
INSERT INTO notification_attempts VALUES('777fac9c-0add-4227-a05d-29ad0d8e4c32','my-team/padme','00000000-0000-4000-8000-000000000006',1,'b5a48595-0eac-41d3-93bd-e4e140d3ca06','inbox','2026-10-16T08:00:51.000Z','2026-10-16T08:00:52.000Z','2026-10-16T08:00:53.000Z');
INSERT INTO notification_attempts VALUES('60e12c8b-5046-427d-a718-d77383873fa4','my-team/padme','00000000-0000-4000-8000-000000000006',1,'b5a48595-0eac-41d3-93bd-e4e140d3ca06','inbox','2026-10-16T08:01:03.000Z','2026-10-16T08:01:04.000Z','2026-10-16T08:01:05.000Z');
CREATE TABLE admin_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT, action TEXT NOT NULL, created_at TEXT NOT NULL
      , actor_kind TEXT, account_id TEXT, lobby_id TEXT, target TEXT, detail TEXT);
INSERT INTO admin_events VALUES(1,'my-team/vader','provision','2026-10-15T12:00:01.000Z','operator',NULL,'my-team','vader',NULL);
INSERT INTO admin_events VALUES(2,'my-team/luke','provision','2026-10-15T12:00:03.000Z','operator',NULL,'my-team','luke',NULL);
INSERT INTO admin_events VALUES(3,'my-team/lando','provision','2026-10-15T12:00:05.000Z','operator',NULL,'my-team','lando',NULL);
INSERT INTO admin_events VALUES(4,'my-team/vader','create_room','2026-10-15T12:00:08.000Z','agent',NULL,'my-team','app',NULL);
INSERT INTO admin_events VALUES(5,'my-team/vader','set_room_members','2026-10-15T12:00:10.000Z','agent',NULL,'my-team','app',NULL);
INSERT INTO admin_events VALUES(6,'my-team/vader','update_agent','2026-10-16T03:00:01.000Z','operator',NULL,'my-team','vader',NULL);
INSERT INTO admin_events VALUES(7,NULL,'create_room','2026-10-16T05:00:01.000Z','operator',NULL,'my-team','social',NULL);
INSERT INTO admin_events VALUES(8,'my-team/vader','create_room','2026-10-16T05:00:04.000Z','agent',NULL,'my-team','night-test',NULL);
INSERT INTO admin_events VALUES(9,'my-team/vader','set_room_members','2026-10-16T05:00:07.000Z','agent',NULL,'my-team','night-test',NULL);
INSERT INTO admin_events VALUES(10,'my-team/vader','delete_room','2026-10-16T05:00:13.000Z','agent',NULL,'my-team','night-test',NULL);
INSERT INTO admin_events VALUES(11,NULL,'board_agents','2026-10-16T05:00:15.000Z','operator',NULL,'my-team',NULL,NULL);
INSERT INTO admin_events VALUES(12,NULL,'board_source_set','2026-10-16T05:00:17.000Z','operator',NULL,'my-team','app',NULL);
INSERT INTO admin_events VALUES(13,NULL,'board_source_set','2026-10-16T05:00:19.000Z','operator',NULL,'my-team','social',NULL);
INSERT INTO admin_events VALUES(14,NULL,'board_password','2026-10-16T05:00:23.000Z','operator',NULL,'my-team',NULL,NULL);
INSERT INTO admin_events VALUES(15,NULL,'grant_lobby','2026-10-16T08:00:03.000Z','operator',NULL,'my-team','owner@example.com',NULL);
INSERT INTO admin_events VALUES(16,NULL,'viewer_add','2026-10-16T08:00:13.000Z','account','91703e61-79db-44de-b732-96e5177e2519','my-team','viewer@example.com',NULL);
INSERT INTO admin_events VALUES(17,NULL,'repo_approve','2026-10-16T08:00:24.000Z','operator',NULL,'my-team','johansan/pocolobby',NULL);
INSERT INTO admin_events VALUES(18,NULL,'summary_settings','2026-10-16T08:00:28.000Z','account','91703e61-79db-44de-b732-96e5177e2519','my-team',NULL,'{"model":"claude-sonnet-5-5","effort":"medium"}');
INSERT INTO admin_events VALUES(19,NULL,'create_room','2026-10-16T08:00:30.000Z','operator',NULL,'my-team','night-shift',NULL);
INSERT INTO admin_events VALUES(20,NULL,'archive_room','2026-10-16T08:00:32.000Z','account','91703e61-79db-44de-b732-96e5177e2519','my-team','night-shift','{"former_members":[]}');
INSERT INTO admin_events VALUES(21,NULL,'create_lobby','2026-10-16T08:00:34.000Z','operator',NULL,'scratch',NULL,NULL);
INSERT INTO admin_events VALUES(22,NULL,'delete_lobby','2026-10-16T08:00:36.000Z','operator',NULL,'scratch',NULL,'{"agents":0}');
INSERT INTO admin_events VALUES(23,'my-team/padme','provision','2026-10-16T08:00:37.000Z','operator',NULL,'my-team','padme',NULL);
INSERT INTO admin_events VALUES(24,'my-team/vader','change_room_members','2026-10-16T08:00:44.000Z','agent',NULL,'my-team','app','{"add":["padme"],"remove":[]}');
CREATE TABLE lobbies (lobby_id TEXT PRIMARY KEY, owner_account TEXT REFERENCES accounts(account_id), created_at TEXT);
INSERT INTO lobbies VALUES('my-team','91703e61-79db-44de-b732-96e5177e2519',NULL);
CREATE TABLE rooms (
        lobby_id TEXT NOT NULL REFERENCES lobbies(lobby_id), room_id TEXT NOT NULL,
        PRIMARY KEY(lobby_id,room_id)
      );
INSERT INTO rooms VALUES('my-team','app');
INSERT INTO rooms VALUES('my-team','social');
CREATE TABLE room_members (
        lobby_id TEXT NOT NULL, room_id TEXT NOT NULL, agent_id TEXT NOT NULL,
        PRIMARY KEY(lobby_id,room_id,agent_id),
        FOREIGN KEY(lobby_id,room_id) REFERENCES rooms(lobby_id,room_id),
        FOREIGN KEY(agent_id,lobby_id) REFERENCES agents(agent_id,lobby_id)
      );
INSERT INTO room_members VALUES('my-team','app','my-team/vader');
INSERT INTO room_members VALUES('my-team','app','my-team/luke');
INSERT INTO room_members VALUES('my-team','app','my-team/padme');
CREATE TABLE schedules (
        id TEXT PRIMARY KEY, sender TEXT NOT NULL REFERENCES agents(agent_id),
        lobby_id TEXT NOT NULL REFERENCES lobbies(lobby_id), request_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL, template TEXT NOT NULL, time_zone TEXT NOT NULL,
        times TEXT NOT NULL, weekdays TEXT, created_at TEXT NOT NULL, next_run_ms INTEGER,
        cancelled_at TEXT, occurrence_count INTEGER NOT NULL DEFAULT 0, last_occurrence_at TEXT,
        last_message_id TEXT, last_error TEXT, UNIQUE (sender, request_id)
      );
INSERT INTO schedules VALUES('ceba1637-8d31-4121-bce9-37c231ba3adb','my-team/vader','my-team','fixture-013-morning','9607dc66dbc1bc6acf7135529b76acc99a3698e71a7329cf67ec5f0338c21d31','{"to":"vader","priority":"info","content":"Morning notice","kind":"notice"}','Europe/Stockholm','["06:41"]','["mon","fri"]','2026-10-15T13:00:16.000Z',1792125660000,NULL,0,NULL,NULL,NULL);
INSERT INTO schedules VALUES('2e9a7da8-b98b-4832-9f61-b28e2787a0fb','my-team/vader','my-team','fixture-013-standup','f7df6e4f776d10c6eede87bbdc1e682c056e474455bdb497f9be441908dff8f6','{"to":"*","priority":"info","content":"Standup reminder without a kind","room":"app"}','Europe/Stockholm','["09:55"]',NULL,'2026-10-15T13:00:18.000Z',1792137300000,NULL,0,NULL,NULL,NULL);
INSERT INTO schedules VALUES('d953cd74-8e25-4812-98a4-3201e7616d88','my-team/vader','my-team','fixture-020-evening','920b46d585a8f3a15300ad2f1f0efe0c9fffd583fedec3a165d28bdf9c6dc4e8','{"to":"vader","priority":"info","content":"Evening notice","kind":"notice"}','Europe/Stockholm','["18:30"]',NULL,'2026-10-15T20:00:10.000Z',1792168200000,NULL,0,NULL,NULL,NULL);
INSERT INTO schedules VALUES('5e977c64-ceab-42a0-a92f-88e9c89de6b9','my-team/vader','my-team','fixture-053-daily','fa9443811a4b79c575a8a52c32e8ea30101180c985d565942b9c3691b443f9c8','{"to":"padme","priority":"info","content":"Daily frame","kind":"notice","attachments":[{"sha256":"2b640882ae1d1107c5712205382693d103f8cf8d9afcb5c5292b6dc1103e04c4","filename":"daily.png","mime_type":"image/png","size":26}]}','Europe/Stockholm','["06:41"]','["mon","wed","fri"]','2026-10-16T08:01:15.000Z',1792384860000,NULL,0,NULL,NULL,NULL);
CREATE TABLE seen_receipts (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        sender TEXT NOT NULL REFERENCES agents(agent_id),
        message_id TEXT NOT NULL REFERENCES messages(id),
        agent_id TEXT NOT NULL REFERENCES agents(agent_id),
        seen_at TEXT NOT NULL, seen_ms INTEGER NOT NULL,
        state TEXT NOT NULL DEFAULT 'due' CHECK (state IN ('due','sent','expired')),
        notification_id TEXT, UNIQUE (message_id, agent_id)
      );
INSERT INTO seen_receipts VALUES(1,'my-team/vader','b0353ef8-d91c-4fa9-b027-6e9e05285600','my-team/luke','2026-10-15T13:00:19.000Z',1792069220000,'due',NULL);
INSERT INTO seen_receipts VALUES(2,'my-team/vader','1822c8f7-4677-4136-8721-0e007725cab2','my-team/luke','2026-10-15T20:00:11.000Z',1792094412000,'due',NULL);
INSERT INTO seen_receipts VALUES(3,'my-team/vader','70e60908-ec36-4970-af03-6ad60dcd409a','my-team/padme','2026-10-16T08:00:54.000Z',1792137655000,'due',NULL);
CREATE TABLE attachment_blobs (
        sha256 TEXT PRIMARY KEY, size INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('image','text')), mime_type TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
INSERT INTO attachment_blobs VALUES('9aec502661f0c4d8fcda948fa0f807c3e2d659a299735419a77200ed59159a18',26,'image','image/png','2026-10-16T03:00:16.000Z');
INSERT INTO attachment_blobs VALUES('2b640882ae1d1107c5712205382693d103f8cf8d9afcb5c5292b6dc1103e04c4',26,'image','image/png','2026-10-16T08:01:12.000Z');
INSERT INTO attachment_blobs VALUES('8b32088f301b726b9cf414556d5862c5e1dc45d803ed3f2034b7c5844c07f13f',27,'text','text/plain','2026-10-16T08:01:16.000Z');
INSERT INTO attachment_blobs VALUES('c47fffce7ab6215da4633829b59605e9bdf14fb3d49b6ac0fe8105e639b9c4f9',8,'text','text/plain','2026-10-16T08:01:20.000Z');
CREATE TABLE attachments (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
        lobby_id TEXT NOT NULL REFERENCES lobbies(lobby_id),
        uploader TEXT NOT NULL REFERENCES agents(agent_id),
        filename TEXT NOT NULL, mime_type TEXT NOT NULL, size INTEGER NOT NULL,
        sha256 TEXT NOT NULL, created_at TEXT NOT NULL, created_ms INTEGER NOT NULL,
        last_referenced_ms INTEGER, expired_at TEXT
      );
INSERT INTO attachments VALUES(1,'b3ef99bc-261b-43f4-a911-94d7ab479796','my-team','my-team/luke','before.png','image/png',26,'9aec502661f0c4d8fcda948fa0f807c3e2d659a299735419a77200ed59159a18','2026-10-16T03:00:19.000Z',1792119619000,1792119619000,NULL);
INSERT INTO attachments VALUES(2,'81f31538-4dfb-44b2-bdc8-eec786616a38','my-team','my-team/vader','daily.png','image/png',26,'2b640882ae1d1107c5712205382693d103f8cf8d9afcb5c5292b6dc1103e04c4','2026-10-16T08:01:15.000Z',1792137675000,1792137675000,NULL);
INSERT INTO attachments VALUES(3,'c6bcf61e-7bc3-4975-88e9-0c9dc40717de','my-team','my-team/padme','plan.md','text/markdown',27,'8b32088f301b726b9cf414556d5862c5e1dc45d803ed3f2034b7c5844c07f13f','2026-10-16T08:01:19.000Z',1792137679000,1792137679000,NULL);
CREATE TABLE message_attachments (
        message_id TEXT NOT NULL REFERENCES messages(id), position INTEGER NOT NULL,
        attachment_id TEXT NOT NULL REFERENCES attachments(id),
        PRIMARY KEY (message_id, position)
      );
INSERT INTO message_attachments VALUES('7ddb54cd-0381-4459-a81f-1f5c267e35e8',0,'b3ef99bc-261b-43f4-a911-94d7ab479796');
INSERT INTO message_attachments VALUES('99f5cc0e-523c-4c28-bb75-1c845440b570',0,'c6bcf61e-7bc3-4975-88e9-0c9dc40717de');
CREATE TABLE schedule_attachments (
        schedule_id TEXT NOT NULL REFERENCES schedules(id), position INTEGER NOT NULL,
        attachment_id TEXT NOT NULL REFERENCES attachments(id),
        PRIMARY KEY (schedule_id, position)
      );
INSERT INTO schedule_attachments VALUES('5e977c64-ceab-42a0-a92f-88e9c89de6b9',0,'81f31538-4dfb-44b2-bdc8-eec786616a38');
CREATE TABLE attachment_uploads (
        uploader TEXT NOT NULL REFERENCES agents(agent_id), sha256 TEXT NOT NULL,
        lobby_id TEXT NOT NULL REFERENCES lobbies(lobby_id), created_ms INTEGER NOT NULL,
        PRIMARY KEY (uploader, sha256)
      );
INSERT INTO attachment_uploads VALUES('my-team/padme','c47fffce7ab6215da4633829b59605e9bdf14fb3d49b6ac0fe8105e639b9c4f9','my-team',1792137680000);
CREATE TABLE board_configs (
        lobby_id TEXT PRIMARY KEY REFERENCES lobbies(lobby_id),
        agents TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL
      , visibility TEXT NOT NULL DEFAULT 'private'
        CHECK (visibility IN ('private','public')), summary_model TEXT NOT NULL DEFAULT 'claude-haiku-5-5', summary_effort TEXT NOT NULL DEFAULT 'low'
        CHECK (summary_effort IN ('low','medium','high')));
INSERT INTO board_configs VALUES('my-team','{"vader":{"emoji":"🌑"},"luke":{"emoji":"⚔️","name":"Luke"}}','2026-10-16T08:00:27.000Z','private','claude-sonnet-5-5','medium');
CREATE TABLE board_sources (
        lobby_id TEXT NOT NULL REFERENCES lobbies(lobby_id), room_id TEXT NOT NULL,
        repo TEXT NOT NULL, ref TEXT NOT NULL, notes TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY (lobby_id, room_id)
      );
INSERT INTO board_sources VALUES('my-team','app','johansan/my-team','main','["notes"]','2026-10-16T05:00:16.000Z');
INSERT INTO board_sources VALUES('my-team','social','JohanSan/my-team-social','main','["PLAN.md"]','2026-10-16T05:00:18.000Z');
CREATE TABLE board_notes (
        lobby_id TEXT NOT NULL, room_id TEXT NOT NULL,
        commit_sha TEXT NOT NULL, files TEXT NOT NULL, fetched_at TEXT NOT NULL,
        PRIMARY KEY (lobby_id, room_id),
        FOREIGN KEY (lobby_id, room_id) REFERENCES board_sources(lobby_id, room_id) ON DELETE CASCADE
      );
INSERT INTO board_notes VALUES('my-team','app','890480f000000000000000000000000000000000','[{"path":"notes/3d.md","sha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","bytes":22,"truncated":false,"content":"# 3D\n- Luke: Now film."}]','2026-10-16T05:00:19.000Z');
CREATE TABLE board_summaries (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        lobby_id TEXT NOT NULL REFERENCES lobbies(lobby_id),
        created_at TEXT NOT NULL, created_ms INTEGER NOT NULL,
        input_hash TEXT NOT NULL, sources TEXT NOT NULL, model TEXT NOT NULL,
        input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
        cache_creation_input_tokens INTEGER NOT NULL, cache_read_input_tokens INTEGER NOT NULL,
        cost_usd REAL NOT NULL, summary TEXT, error TEXT,
        CHECK ((summary IS NULL) <> (error IS NULL))
      );
INSERT INTO board_summaries VALUES(1,'my-team','2026-10-16T05:00:20.000Z',1792126820000,'fixture-good','[{"room_id":"app","repo":"johansan/my-team","commit_sha":"890480f000000000000000000000000000000000"}]','claude-haiku-5-5',18000,1500,0,1100,0.0026,'{"verdict":{"runway":"low","headline":"Luke runs low.","sentence":"One task left.","tell_coordinator":"queue the next film"},"waiting":[],"agents":[{"agent_id":"luke","now":"Film the deck","waits_on_johan":null,"ready":["Edit"],"ready_count":1}],"pipeline":[]}',NULL);
INSERT INTO board_summaries VALUES(2,'my-team','2026-10-16T05:00:21.000Z',1792126821000,'fixture-failed','[{"room_id":"app","repo":"johansan/my-team","commit_sha":"890480f000000000000000000000000000000000"}]','claude-haiku-5-5',18000,1500,0,1100,0.0026,NULL,'The summary was not valid JSON');
INSERT INTO board_summaries VALUES(3,'my-team','2026-10-16T08:00:29.000Z',1792137629000,'fixture-053','[{"room_id":"app","repo":"johansan/my-team","commit_sha":"cccccccccccccccccccccccccccccccccccccccc"}]','claude-sonnet-5-5',20000,1800,0,1200,0.087,'{"verdict":{"runway":"ok","headline":"Padmé joins the app room.","sentence":"Two tasks are queued.","tell_coordinator":"nothing"},"waiting":[],"agents":[{"agent_id":"padme","now":"Plan the release","waits_on_johan":null,"ready":null}],"pipeline":[]}',NULL);
CREATE TABLE accounts (
        account_id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE,
        may_create_lobbies INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, disabled_at TEXT
      );
INSERT INTO accounts VALUES('91703e61-79db-44de-b732-96e5177e2519','owner@example.com',0,'2026-10-16T08:00:02.000Z',NULL);
INSERT INTO accounts VALUES('bb83abd5-3aa3-4534-8e9a-b5e21bcafefe','viewer@example.com',0,'2026-10-16T08:00:11.000Z',NULL);
CREATE TABLE deleted_lobbies (lobby_id TEXT PRIMARY KEY, deleted_at TEXT NOT NULL);
INSERT INTO deleted_lobbies VALUES('scratch','2026-10-16T08:00:35.000Z');
CREATE TABLE lobby_repos (
        lobby_id TEXT NOT NULL REFERENCES lobbies(lobby_id), repo TEXT NOT NULL,
        added_at TEXT NOT NULL, PRIMARY KEY (lobby_id, repo)
      );
INSERT INTO lobby_repos VALUES('my-team','johansan/my-team','2026-10-16T08:00:01.000Z');
INSERT INTO lobby_repos VALUES('my-team','johansan/my-team-social','2026-10-16T08:00:01.000Z');
INSERT INTO lobby_repos VALUES('my-team','johansan/pocolobby','2026-10-16T08:00:23.000Z');
CREATE TABLE archived_rooms (
        lobby_id TEXT NOT NULL REFERENCES lobbies(lobby_id), room_id TEXT NOT NULL,
        archived_at TEXT NOT NULL, PRIMARY KEY (lobby_id, room_id)
      );
INSERT INTO archived_rooms VALUES('my-team','night-shift','2026-10-16T08:00:31.000Z');
CREATE TABLE board_viewers (
        lobby_id TEXT NOT NULL REFERENCES lobbies(lobby_id),
        account_id TEXT NOT NULL REFERENCES accounts(account_id),
        added_at TEXT NOT NULL, PRIMARY KEY (lobby_id, account_id)
      );
INSERT INTO board_viewers VALUES('my-team','bb83abd5-3aa3-4534-8e9a-b5e21bcafefe','2026-10-16T08:00:12.000Z');
CREATE TABLE board_sessions (
        token_hash TEXT PRIMARY KEY, lobby_id TEXT NOT NULL REFERENCES lobbies(lobby_id),
        account_id TEXT NOT NULL REFERENCES accounts(account_id),
        created_ms INTEGER NOT NULL, expires_ms INTEGER NOT NULL
      );
INSERT INTO board_sessions VALUES('f01b57226261ae3756b93936e1c4e6b849f9a5b0933fa3b91843bf4195b9d964','my-team','bb83abd5-3aa3-4534-8e9a-b5e21bcafefe',1792137616000,1794729616000);
CREATE TABLE board_handoffs (
        token_hash TEXT PRIMARY KEY, lobby_id TEXT NOT NULL REFERENCES lobbies(lobby_id),
        account_id TEXT NOT NULL REFERENCES accounts(account_id), expires_ms INTEGER NOT NULL
      );
INSERT INTO board_handoffs VALUES('3907791a831e2e5c383fba601a0f08e0bfae87a56c2f45121101976d874ee3d6','my-team','91703e61-79db-44de-b732-96e5177e2519',1792137677000);
CREATE TABLE console_sessions (
        token_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(account_id),
        created_ms INTEGER NOT NULL, refreshed_ms INTEGER NOT NULL, expires_ms INTEGER NOT NULL
      );
INSERT INTO console_sessions VALUES('0c49d89230696ff3c031ca5a128a4e121e3589bf872c17fa04487ed0cc245d21','91703e61-79db-44de-b732-96e5177e2519',1792137610000,1792137610000,1794729610000);
CREATE TABLE sign_in_codes (
        email_key TEXT PRIMARY KEY, code_mac TEXT NOT NULL, created_ms INTEGER NOT NULL,
        expires_ms INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0
      );
INSERT INTO sign_in_codes VALUES('21376cd50613e34bfecd71bd98a971e9735cb6aaa543bd06cd4a184bc4e93886','e81a44e0aba222b2f5580312147aeae9ccb9273b7089f66889884c575b833694',1792137622000,1792138222000,0);
CREATE TABLE sign_in_limits (
        key TEXT PRIMARY KEY, window_ms INTEGER NOT NULL, count INTEGER NOT NULL
      );
INSERT INTO sign_in_limits VALUES('send:59a08fabe68f6b17af57a9fcac64915844ce5f7594178414692f9287264ef68b',1792137606000,1);
INSERT INTO sign_in_limits VALUES('send:all',1792137607000,2);
INSERT INTO sign_in_limits VALUES('send:21376cd50613e34bfecd71bd98a971e9735cb6aaa543bd06cd4a184bc4e93886',1792137620000,1);
DELETE FROM sqlite_sequence;
INSERT INTO sqlite_sequence VALUES('admin_events',24);
INSERT INTO sqlite_sequence VALUES('messages',26);
INSERT INTO sqlite_sequence VALUES('seen_receipts',3);
INSERT INTO sqlite_sequence VALUES('attachments',3);
INSERT INTO sqlite_sequence VALUES('board_summaries',3);
CREATE INDEX messages_sender_time ON messages(sender, created_ms);
CREATE INDEX deliveries_pending ON deliveries(agent_id, seen_at, next_attempt_at);
CREATE INDEX notification_attempts_agent_time ON notification_attempts(agent_id,created_at);
CREATE UNIQUE INDEX agents_principal_lobby ON agents(agent_id,lobby_id);
CREATE INDEX messages_lobby_sequence ON messages(lobby_id,sequence);
CREATE INDEX deliveries_notification ON deliveries(last_notification_id);
CREATE INDEX messages_due ON messages(deliver_at_ms)
        WHERE deliver_at_ms IS NOT NULL AND released_ms IS NULL AND cancelled_at IS NULL;
CREATE UNIQUE INDEX messages_occurrence ON messages(schedule_id, deliver_at_ms)
        WHERE schedule_id IS NOT NULL;
CREATE INDEX schedules_due ON schedules(next_run_ms) WHERE cancelled_at IS NULL;
CREATE INDEX seen_receipts_due ON seen_receipts(sender, sequence) WHERE state='due';
CREATE UNIQUE INDEX attachments_identity ON attachments(uploader,sha256,filename)
        WHERE expired_at IS NULL;
CREATE INDEX attachments_lobby ON attachments(lobby_id,sequence);
CREATE INDEX attachments_content ON attachments(sha256) WHERE expired_at IS NULL;
CREATE INDEX message_attachments_attachment ON message_attachments(attachment_id);
CREATE INDEX schedule_attachments_attachment ON schedule_attachments(attachment_id);
CREATE INDEX attachment_uploads_content ON attachment_uploads(sha256);
CREATE INDEX board_summaries_lobby ON board_summaries(lobby_id, sequence);
CREATE INDEX lobbies_owner ON lobbies(owner_account);
CREATE INDEX board_viewers_account ON board_viewers(account_id);
CREATE INDEX board_sessions_lobby ON board_sessions(lobby_id);
CREATE INDEX board_sessions_account ON board_sessions(account_id);
CREATE INDEX console_sessions_account ON console_sessions(account_id);
CREATE INDEX admin_events_lobby ON admin_events(lobby_id, sequence);
CREATE INDEX messages_bytes ON messages(byte_size);
COMMIT;
PRAGMA user_version=10;
