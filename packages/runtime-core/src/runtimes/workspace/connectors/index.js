'use strict';

/**
 * Connectors — poll-based external sources (GitHub issues, Slack, Google
 * Calendar, CalDAV, MS Teams) mirrored into the workspace, with write-back to
 * the source for the drivers that support it.
 *
 *   BaseConnector.js    the driver contract — extend it, implement the verbs
 *   drivers.js          the registration list — add the class, done
 *   registry.js         derives driver/scheme/secret/form tables from statics
 *   ConnectorIndex.js   the driver-agnostic runtime (poll, cursors, ingest)
 *
 * See docs/connectors.md.
 */

export {
    CONNECTOR_SCHEMES,
    isConnectorDriver,
    connectorDriverForProvenanceUrl,
    describeConnectorDrivers,
} from './registry.js';
export { WorkspaceConnectorIndex } from './ConnectorIndex.js';
