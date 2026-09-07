"use strict";

const cheerio = require("cheerio");

module.exports = async function handler(req, res) {
    if (req.method !== "POST") {
        return res.status(405).json({
            success: false,
            error: {
                code: "METHOD_NOT_ALLOWED",
                message: "Only POST requests are allowed."
            }
        });
    }

    try {
        const {
            url,
            method = "GET",
            timeout = 10,
            mode = "auto",
            content = []
        } = req.body || {};

        // -----------------------------
        // Validate URL
        // -----------------------------

        if (!url) {
            return res.status(400).json({
                success: false,
                error: {
                    code: "MISSING_URL",
                    message: "A URL is required."
                }
            });
        }

        let targetUrl;

        try {
            targetUrl = new URL(url);
        } catch {
            return res.status(400).json({
                success: false,
                error: {
                    code: "INVALID_URL",
                    message: "The provided URL is not valid."
                }
            });
        }

        if (!["http:", "https:"].includes(targetUrl.protocol)) {
            return res.status(400).json({
                success: false,
                error: {
                    code: "UNSUPPORTED_PROTOCOL",
                    message: "Only HTTP and HTTPS URLs are supported."
                }
            });
        }

        // -----------------------------
        // Validate request configuration
        // -----------------------------

        if (method !== "GET") {
            return res.status(400).json({
                success: false,
                error: {
                    code: "UNSUPPORTED_METHOD",
                    message: "Only GET requests are supported."
                }
            });
        }

        const timeoutSeconds = Number(timeout);

        if (![5, 10, 20, 30].includes(timeoutSeconds)) {
            return res.status(400).json({
                success: false,
                error: {
                    code: "INVALID_TIMEOUT",
                    message: "Timeout must be 5, 10, 20 or 30 seconds."
                }
            });
        }

        // -----------------------------
        // Fetch source
        // -----------------------------

        const startedAt = Date.now();
        const controller = new AbortController();

        const timeoutId = setTimeout(() => {
            controller.abort();
        }, timeoutSeconds * 1000);

        let response;

        try {
            response = await fetch(targetUrl.toString(), {
                method: "GET",
                headers: {
                    "User-Agent": "Mozilla/5.0 (compatible; WebScraper/0.3)"
                },
                signal: controller.signal
            });
        } finally {
            clearTimeout(timeoutId);
        }

        const contentType =
            response.headers.get("content-type") || "";

        // -----------------------------
        // Validate content type
        // -----------------------------

        if (!contentType.includes("text/html")) {
            return res.status(415).json({
                success: false,
                error: {
                    code: "UNSUPPORTED_CONTENT_TYPE",
                    message: "The source does not return an HTML document."
                },
                meta: {
                    url: targetUrl.toString(),
                    status: response.status,
                    contentType,
                    duration: Date.now() - startedAt
                }
            });
        }

        const html = await response.text();

        // -----------------------------
        // Parse HTML
        // -----------------------------

        const $ = cheerio.load(html);

        const metadata = extractMetadata($, targetUrl);
        const text = extractText($);
        const links = extractLinks($, targetUrl);
        const tables = extractTables($);

        const duration = Date.now() - startedAt;

        // -----------------------------
        // Respect selected content
        // -----------------------------

        const selectedContent = {
            metadata: content.includes("metadata") ? metadata : {},
            text: content.includes("text") ? text : [],
            links: content.includes("links") ? links : [],
            tables: content.includes("tables") ? tables : []
        };

        // -----------------------------
        // Return structured result
        // -----------------------------

        return res.status(200).json({
            success: true,

            data: selectedContent,

            meta: {
                url: targetUrl.toString(),
                status: response.status,
                statusText: response.statusText,
                contentType,
                contentLength: html.length,
                duration
            },

            request: {
                method,
                timeout: timeoutSeconds,
                mode,
                content
            }
        });

    } catch (error) {
        console.error("Scraper API error:", error);

        if (error.name === "AbortError") {
            return res.status(408).json({
                success: false,
                error: {
                    code: "REQUEST_TIMEOUT",
                    message: "The source took too long to respond."
                }
            });
        }

        return res.status(500).json({
            success: false,
            error: {
                code: "FETCH_FAILED",
                message: "The requested source could not be fetched."
            }
        });
    }
};


// ==========================================
// Metadata
// ==========================================

function extractMetadata($, targetUrl) {
    return {
        title: $("title").first().text().trim() || null,

        description:
            $('meta[name="description"]')
                .attr("content")
                ?.trim() || null,

        canonical:
            $('link[rel="canonical"]')
                .attr("href") || targetUrl.toString()
    };
}


// ==========================================
// Text
// ==========================================

function extractText($) {
    const text = [];

    $("h1, h2, h3, h4, h5, h6, p").each((_, element) => {
        const value = $(element)
            .text()
            .replace(/\s+/g, " ")
            .trim();

        if (value) {
            text.push(value);
        }
    });

    return text;
}


// ==========================================
// Links
// ==========================================

function extractLinks($, baseUrl) {
    const links = [];

    $("a[href]").each((_, element) => {
        const text = $(element)
            .text()
            .replace(/\s+/g, " ")
            .trim();

        const href = $(element).attr("href");

        if (!href) return;

        try {
            const absoluteUrl = new URL(href, baseUrl).toString();

            links.push({
                text: text || absoluteUrl,
                url: absoluteUrl
            });

        } catch {
            // Ignore malformed URLs
        }
    });

    return links;
}


// ==========================================
// Tables
// ==========================================

function extractTables($) {
    const tables = [];

    $("table").each((_, table) => {
        const rows = [];

        // Extraer todas las filas, sin depender de thead/tbody
        $(table)
            .find("tr")
            .each((_, row) => {
                const cells = [];

                $(row)
                    .find("th, td")
                    .each((_, cell) => {
                        const value = $(cell)
                            .text()
                            .replace(/\s+/g, " ")
                            .trim();

                        cells.push(value);
                    });

                // Ignorar filas completamente vacías
                if (cells.some(Boolean)) {
                    rows.push(cells);
                }
            });

        if (!rows.length) {
            return;
        }

        // ------------------------------------------
        // Detectar encabezados
        // ------------------------------------------

        let headers = [];
        let dataRows = rows;

        const firstRow = rows[0];

        const firstRowHasTh =
            $(table)
                .find("tr")
                .first()
                .find("th")
                .length > 0;

        if (firstRowHasTh && firstRow.length > 1) {
            headers = firstRow;
            dataRows = rows.slice(1);
        }

        // ------------------------------------------
        // Detectar estructuras Campo → Valor
        // ------------------------------------------

        const keyValue = [];

        for (const row of rows) {
            if (row.length < 2) {
                continue;
            }

            const key = row[0];

            const value = row
                .slice(1)
                .filter(Boolean)
                .join(" | ");

            if (key && value) {
                keyValue.push({
                    key,
                    value
                });
            }
        }

        // ------------------------------------------
        // Guardar tabla
        // ------------------------------------------

        tables.push({
            headers,
            rows: dataRows,
            keyValue
        });
    });

    return tables;
}