
/* =========================================================
   SCRAPER — FRONTEND CONTROLLER
   Version: 0.2
   ========================================================= */

"use strict";


/* =========================================================
   DOM ELEMENTS
   ========================================================= */

const form = document.getElementById("scraper-form");
const urlInput = document.getElementById("scraper-url");
const submitButton = document.getElementById("scraper-submit");

const submitLabel = document.querySelector(".submit-label");
const submitLoading = document.getElementById("submit-loading");

const systemStatusText =
    document.getElementById("system-status-text");

const resultsCount =
    document.getElementById("results-count");

const emptyState =
    document.getElementById("empty-state");

const errorState =
    document.getElementById("error-state");

const errorMessage =
    document.getElementById("error-message");

const resultsTableWrapper =
    document.getElementById("results-table-wrapper");

const resultsBody =
    document.getElementById("results-body");

const exportJsonButton =
    document.getElementById("export-json");

const exportCsvButton =
    document.getElementById("export-csv");

const activityPanel =
    document.getElementById("activity-panel");


/* =========================================================
   CONFIGURATION ELEMENTS
   ========================================================= */

const methodInput =
    document.getElementById("request-method");

const timeoutInput =
    document.getElementById("request-timeout");

const extractionModeInput =
    document.getElementById("extraction-mode");

const contentInputs =
    document.querySelectorAll(
        'input[name="content"]'
    );


/* =========================================================
   APPLICATION STATE
   ========================================================= */

const state = {

    isLoading: false,

    results: [],

    lastUrl: null,

    lastRequest: null

};


/* =========================================================
   INITIALIZATION
   ========================================================= */

document.addEventListener(
    "DOMContentLoaded",
    initializeApplication
);


function initializeApplication() {

    updateResultsCount();

    disableExportButtons();

    setSystemStatus("ready");

    logActivity(
        "System initialized."
    );

}


/* =========================================================
   FORM SUBMISSION
   ========================================================= */

form.addEventListener(
    "submit",
    async (event) => {

        event.preventDefault();

        if (state.isLoading) {
            return;
        }

        const url =
            urlInput.value.trim();

        if (!validateUrl(url)) {
            return;
        }

        const configuration =
            getScraperConfiguration();

        await startScraping(
            url,
            configuration
        );

    }
);


/* =========================================================
   GET SCRAPER CONFIGURATION
   ========================================================= */

function getScraperConfiguration() {

    const content = [];

    contentInputs.forEach(
        (input) => {

            if (input.checked) {
                content.push(input.value);
            }

        }
    );


    return {

        method:
            methodInput?.value || "GET",

        timeout:
            Number(timeoutInput?.value || 10),

        mode:
            extractionModeInput?.value || "auto",

        content

    };

}


/* =========================================================
   URL VALIDATION
   ========================================================= */

function validateUrl(value) {

    if (!value) {

        showError(
            "Please enter a website URL."
        );

        urlInput.focus();

        return false;
    }


    try {

        const url =
            new URL(value);


        if (
            url.protocol !== "http:" &&
            url.protocol !== "https:"
        ) {

            throw new Error(
                "Invalid protocol"
            );

        }


        clearError();

        return true;

    } catch {

        showError(
            "Please enter a valid HTTP or HTTPS URL."
        );

        urlInput.focus();

        return false;

    }

}


/* =========================================================
   START SCRAPING
   ========================================================= */

async function startScraping(
    url,
    configuration
) {

    setLoading(true);

    clearResults();

    state.lastUrl = url;

    state.lastRequest = {

        url,

        ...configuration

    };


    setSystemStatus(
        "processing"
    );


    logActivity(
        `Scraping request initialized for ${url}`
    );


    try {

        logActivity(
            "Validating request..."
        );


        validateConfiguration(
            configuration
        );


        logActivity(
            "Sending request to extraction engine..."
        );


        const response =
            await fetch(
                "/api/scrape",
                {

                    method: "POST",

                    headers: {
                        "Content-Type":
                            "application/json"
                    },

                    body: JSON.stringify({

                        url,

                        method:
                            configuration.method,

                        timeout:
                            configuration.timeout,

                        mode:
                            configuration.mode,

                        content:
                            configuration.content

                    })

                }
            );


        logActivity(
            `Extraction engine responded with HTTP ${response.status}.`
        );


        let result;


        try {

            result =
                await response.json();

        } catch {

            throw new Error(
                "The extraction engine returned an invalid response."
            );

        }


        if (
            !response.ok ||
            !result.success
        ) {

            const message =
                result?.error?.message ||
                "The source could not be processed.";

            throw new Error(
                message
            );

        }


        const data =
            normalizeResults(
                result
            );


        state.results =
            data;


        renderResults(
            data
        );


        logActivity(
            `${data.length} records extracted successfully.`
        );


        if (result.meta) {

            if (result.meta.status) {

                logActivity(
                    `Source HTTP status: ${result.meta.status}.`
                );

            }

            if (result.meta.duration) {

                logActivity(
                    `Extraction completed in ${result.meta.duration} ms.`
                );

            }

        }


        setSystemStatus(
            "ready"
        );


    } catch (error) {

        console.error(
            "Scraping error:",
            error
        );


        showError(
            error.message ||
            "Something went wrong while processing the requested source."
        );


        setSystemStatus(
            "error"
        );


        logActivity(
            `Extraction failed: ${error.message}`
        );


    } finally {

        setLoading(false);

    }

}


/* =========================================================
   CONFIGURATION VALIDATION
   ========================================================= */

function validateConfiguration(
    configuration
) {

    const allowedMethods = [
        "GET"
    ];


    if (
        !allowedMethods.includes(
            configuration.method
        )
    ) {

        throw new Error(
            "Unsupported request method."
        );

    }


    const allowedTimeouts = [
        5,
        10,
        20,
        30
    ];


    if (
        !allowedTimeouts.includes(
            configuration.timeout
        )
    ) {

        throw new Error(
            "Invalid timeout configuration."
        );

    }


    const allowedModes = [
        "auto",
        "structured",
        "custom"
    ];


    if (
        !allowedModes.includes(
            configuration.mode
        )
    ) {

        throw new Error(
            "Invalid extraction mode."
        );

    }


    if (
        !Array.isArray(
            configuration.content
        ) ||
        configuration.content.length === 0
    ) {

        throw new Error(
            "Select at least one data type to extract."
        );

    }

}


/* =========================================================
   NORMALIZE BACKEND RESPONSE
   ========================================================= */

function normalizeResults(
    result
) {

    /*
     * The backend can eventually return
     * structured data by category.
     *
     * For now we support:
     *
     * 1. data as an array
     * 2. data as an object
     */

    if (
        Array.isArray(
            result.data
        )
    ) {

        return result.data;

    }


    if (
        result.data &&
        typeof result.data === "object"
    ) {

        return flattenStructuredData(
            result.data
        );

    }


    return [];

}


/* =========================================================
   FLATTEN STRUCTURED DATA
   ========================================================= */

function flattenStructuredData(
    data
) {

    const results = [];


    /*
     * Metadata
     */

    if (data.metadata) {

        Object.entries(
            data.metadata
        ).forEach(
            ([key, value]) => {

                results.push({

                    name: key,

                    url:
                        state.lastUrl || "",

                    type: "metadata",

                    content:
                        String(value ?? "")

                });

            }
        );

    }


    /*
     * Text
     */

    if (
        Array.isArray(
            data.text
        )
    ) {

        data.text.forEach(
            (text, index) => {

                results.push({

                    name:
                        `Text ${index + 1}`,

                    url:
                        state.lastUrl || "",

                    type: "text",

                    content:
                        String(text ?? "")

                });

            }
        );

    }


    /*
     * Links
     */

    if (
        Array.isArray(
            data.links
        )
    ) {

        data.links.forEach(
            (link, index) => {

                results.push({

                    name:
                        link.text ||
                        `Link ${index + 1}`,

                    url:
                        link.url ||
                        state.lastUrl ||
                        "",

                    type: "link",

                    content:
                        link.text ||
                        link.url ||
                        ""

                });

            }
        );

    }


    /*
     * Tables
     *
     * Tables are converted into
     * readable JSON strings for
     * the current results table.
     */

    if (
        Array.isArray(
            data.tables
        )
    ) {

        data.tables.forEach(
            (table, index) => {

                results.push({

                    name:
                        `Table ${index + 1}`,

                    url:
                        state.lastUrl || "",

                    type: "table",

                    content:
                        JSON.stringify(
                            table
                        )

                });

            }
        );

    }


    return results;

}


/* =========================================================
   RENDER RESULTS
   ========================================================= */

function renderResults(
    data
) {

    hideElement(
        emptyState
    );

    hideElement(
        errorState
    );


    if (!data.length) {

        showElement(
            emptyState
        );

        updateResultsCount();

        disableExportButtons();

        return;

    }


    showElement(
        resultsTableWrapper
    );


    resultsBody.innerHTML = "";


    data.forEach(
        (item) => {

            const row =
                document.createElement("tr");


            row.innerHTML = `

                <td>
                    ${escapeHtml(
                        item.name ?? ""
                    )}
                </td>

                <td>
                    ${
                        item.url
                            ? `
                                <a
                                    href="${escapeAttribute(
                                        item.url
                                    )}"
                                    target="_blank"
                                    rel="noopener noreferrer"
                                >
                                    ${escapeHtml(
                                        item.url
                                    )}
                                </a>
                              `
                            : "—"
                    }
                </td>

                <td>
                    ${escapeHtml(
                        item.type ?? ""
                    )}
                </td>

                <td>
                    ${escapeHtml(
                        item.content ?? ""
                    )}
                </td>

            `;


            resultsBody.appendChild(
                row
            );

        }
    );


    updateResultsCount();

    enableExportButtons();

}


/* =========================================================
   CLEAR RESULTS
   ========================================================= */

function clearResults() {

    state.results = [];

    resultsBody.innerHTML = "";


    hideElement(
        resultsTableWrapper
    );


    hideElement(
        errorState
    );


    showElement(
        emptyState
    );


    updateResultsCount();

    disableExportButtons();

}


/* =========================================================
   RESULTS COUNT
   ========================================================= */

function updateResultsCount() {

    const count =
        state.results.length;


    resultsCount.textContent =
        `${count} ${
            count === 1
                ? "record"
                : "records"
        }`;

}


/* =========================================================
   LOADING STATE
   ========================================================= */

function setLoading(
    isLoading
) {

    state.isLoading =
        isLoading;


    if (isLoading) {

        submitButton.disabled =
            true;

        submitButton.classList.add(
            "is-loading"
        );


        if (submitLabel) {

            submitLabel.hidden =
                true;

        }


        if (submitLoading) {

            submitLoading.hidden =
                false;

        }

    } else {

        submitButton.disabled =
            false;

        submitButton.classList.remove(
            "is-loading"
        );


        if (submitLabel) {

            submitLabel.hidden =
                false;

        }


        if (submitLoading) {

            submitLoading.hidden =
                true;

        }

    }

}


/* =========================================================
   SYSTEM STATUS
   ========================================================= */

function setSystemStatus(
    status
) {

    const statusConfig = {

        ready: {

            text:
                "System Ready",

            className:
                "status-success"

        },

        processing: {

            text:
                "Processing",

            className:
                "status-warning"

        },

        error: {

            text:
                "System Error",

            className:
                "status-error"

        }

    };


    const config =
        statusConfig[status] ||
        statusConfig.ready;


    systemStatusText.textContent =
        config.text;


    systemStatusText.className =
        config.className;

}


/* =========================================================
   ERROR HANDLING
   ========================================================= */

function showError(
    message
) {

    errorMessage.textContent =
        message;


    hideElement(
        emptyState
    );


    hideElement(
        resultsTableWrapper
    );


    showElement(
        errorState
    );

}


function clearError() {

    hideElement(
        errorState
    );

}


/* =========================================================
   EXPORT — JSON
   ========================================================= */

exportJsonButton.addEventListener(
    "click",
    () => {

        if (
            !state.results.length
        ) {

            return;

        }


        const json =
            JSON.stringify(
                state.results,
                null,
                2
            );


        downloadFile(
            json,
            "scraping-results.json",
            "application/json"
        );


        logActivity(
            "JSON export generated."
        );

    }
);


/* =========================================================
   EXPORT — CSV
   ========================================================= */

exportCsvButton.addEventListener(
    "click",
    () => {

        if (
            !state.results.length
        ) {

            return;

        }


        const csv =
            convertToCsv(
                state.results
            );


        downloadFile(
            csv,
            "scraping-results.csv",
            "text/csv;charset=utf-8;"
        );


        logActivity(
            "CSV export generated."
        );

    }
);


/* =========================================================
   CSV CONVERTER
   ========================================================= */

function convertToCsv(
    data
) {

    if (!data.length) {
        return "";
    }


    const headers = [
        "name",
        "url",
        "type",
        "content"
    ];


    const rows =
        data.map(
            (item) => {

                return headers
                    .map(
                        (header) =>
                            csvEscape(
                                item[header] ?? ""
                            )
                    )
                    .join(",");

            }
        );


    return [
        headers.join(","),
        ...rows
    ].join("\n");

}


function csvEscape(
    value
) {

    const stringValue =
        String(value)
            .replace(
                /"/g,
                '""'
            );


    return `"${stringValue}"`;

}


/* =========================================================
   DOWNLOAD FILE
   ========================================================= */

function downloadFile(
    content,
    filename,
    mimeType
) {

    const blob =
        new Blob(
            [content],
            {
                type: mimeType
            }
        );


    const downloadUrl =
        URL.createObjectURL(
            blob
        );


    const link =
        document.createElement(
            "a"
        );


    link.href =
        downloadUrl;

    link.download =
        filename;


    document.body.appendChild(
        link
    );


    link.click();


    link.remove();


    URL.revokeObjectURL(
        downloadUrl
    );

}


/* =========================================================
   ACTIVITY LOG
   ========================================================= */

function logActivity(
    message
) {

    if (!activityPanel) {
        return;
    }


    const now =
        new Date();


    const time =
        now.toLocaleTimeString(
            [],
            {
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit"
            }
        );


    const line =
        document.createElement(
            "div"
        );


    line.className =
        "activity-line";


    line.innerHTML = `

        <span class="activity-time">
            ${escapeHtml(time)}
        </span>

        <span class="activity-message">
            ${escapeHtml(message)}
        </span>

    `;


    activityPanel.appendChild(
        line
    );


    activityPanel.scrollTop =
        activityPanel.scrollHeight;

}


/* =========================================================
   EXPORT BUTTON STATES
   ========================================================= */

function enableExportButtons() {

    exportJsonButton.disabled =
        false;

    exportCsvButton.disabled =
        false;

}


function disableExportButtons() {

    exportJsonButton.disabled =
        true;

    exportCsvButton.disabled =
        true;

}


/* =========================================================
   DOM HELPERS
   ========================================================= */

function showElement(
    element
) {

    if (!element) {
        return;
    }

    element.hidden =
        false;

}


function hideElement(
    element
) {

    if (!element) {
        return;
    }

    element.hidden =
        true;

}


/* =========================================================
   SECURITY HELPERS
   ========================================================= */

function escapeHtml(
    value
) {

    return String(value)
        .replace(
            /&/g,
            "&amp;"
        )
        .replace(
            /</g,
            "&lt;"
        )
        .replace(
            />/g,
            "&gt;"
        )
        .replace(
            /"/g,
            "&quot;"
        )
        .replace(
            /'/g,
            "&#039;"
        );

}


function escapeAttribute(
    value
) {

    return escapeHtml(
        value
    );

}

