-- Runs ONCE, only when the data volume is empty (first `docker compose up`).
-- Changing this file later does nothing until you `docker compose down -v`.
--
-- One Postgres server, one database per service: each service owns its schema
-- and never reads another service's tables. (In prod these could be separate
-- servers; the boundary is what matters.)

CREATE DATABASE inventory;
CREATE DATABASE booking;
CREATE DATABASE payment;
CREATE DATABASE assistant;

\connect assistant
CREATE EXTENSION IF NOT EXISTS vector;
