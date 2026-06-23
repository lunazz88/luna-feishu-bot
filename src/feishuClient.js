const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { config, assertConfig } = require('./config');
const {
  normalizeCommon,
  valueToNumber,
  valueToText,
} = require('./matcher');

const axios = require(path.join(config.nodeModulesDir, 'axios'));
const FormData = require(path.join(config.nodeModulesDir, 'form-data'));
const client = axios.create({ timeout: 30000 });

const FIELD = {
  date: ['日期'],
  project: ['项目', '项目名称'],
  code: ['Code', 'code', 'CODE'],
  shooter: ['投手'],
  country: ['国家'],
  kpi: ['KPI(美金）', 'KPI'],
  spend: ['花费', '花费金额'],
  impressions: ['展示数', '展示次数'],
  clicks: ['点击数', '点击量'],
  registrations: ['注册数', '注册人数'],
  firstDeposits: ['首存数', '首存人数'],
  crawlStatus: ['抓取状态', '抓取\n状态'],
};

const TARGET_METRIC_FIELDS = {
  spend: '花费金额',
  impressions: '展示次数',
  clicks: '点击量',
  registrations: '注册人数',
  firstDeposits: '首存人数',
};

function apiError(apiPath, error) {
  return {
    apiPath,
    httpStatus: error.response ? error.response.status : 'no response',
    code: error.response && error.response.data ? error.response.data.code : undefined,
    msg: error.response && error.response.data ? error.response.data.msg : error.message,
    data: error.response && error.response.data ? error.response.data : undefined,
  };
}

async function tenantAccessToken(appConfig) {
  assertConfig(appConfig);
  const response = await client.post(`${appConfig.baseUrl}/open-apis/auth/v3/tenant_access_token/internal/`, {
    app_id: appConfig.appId,
    app_secret: appConfig.appSecret,
  });
  if (!response.data || response.data.code !== 0 || !response.data.tenant_access_token) {
    const error = new Error('Failed to get tenant access token');
    error.response = { status: response.status, data: response.data };
    throw error;
  }
  return response.data.tenant_access_token;
}

class FeishuClient {
  constructor(appConfig = config) {
    this.config = appConfig;
    this.headers = null;
  }

  async init() {
    const token = await tenantAccessToken(this.config);
    this.headers = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8',
    };
    return this;
  }

  async request(apiPath, options = {}) {
    try {
      const response = await client.request({
        url: this.config.baseUrl + apiPath,
        headers: this.headers,
        ...options,
      });
      if (!response.data || response.data.code !== 0) {
        const error = new Error('Lark API error');
        error.response = { status: response.status, data: response.data };
        throw error;
      }
      return response.data.data || {};
    } catch (error) {
      const wrapped = new Error(`API failed: ${apiPath}`);
      wrapped.details = apiError(apiPath, error);
      throw wrapped;
    }
  }

  async downloadMessageResource(messageId, fileKey, type = 'file') {
    try {
      const response = await client.request({
        url: `${this.config.baseUrl}/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/resources/${encodeURIComponent(fileKey)}`,
        headers: this.headers,
        method: 'GET',
        params: { type },
        responseType: 'arraybuffer',
      });
      return Buffer.from(response.data);
    } catch (error) {
      const wrapped = new Error(`API failed: download message resource`);
      wrapped.details = apiError(`/open-apis/im/v1/messages/${messageId}/resources/${fileKey}`, error);
      throw wrapped;
    }
  }

  async downloadMessageResourceToFile(messageId, fileKey, outputPath, type = 'file') {
    const buffer = await this.downloadMessageResource(messageId, fileKey, type);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, buffer);
    return { outputPath, bytes: buffer.length };
  }

  appToken(url) {
    const parts = new URL(url).pathname.split('/').filter(Boolean);
    const index = parts.indexOf('base');
    return index >= 0 ? parts[index + 1] : parts.at(-1);
  }

  wikiToken(url) {
    return new URL(url).pathname.split('/').filter(Boolean).at(-1);
  }

  async resolveBitableAppToken(url) {
    const parsed = new URL(url);
    if (parsed.pathname.includes('/wiki/')) {
      const nodeData = await this.request('/open-apis/wiki/v2/spaces/get_node', {
        method: 'GET',
        params: { token: this.wikiToken(url) },
      });
      const token = nodeData.node && nodeData.node.obj_token;
      if (!token) throw new Error('Wiki node did not return bitable app token');
      return token;
    }
    return this.appToken(url);
  }

  copiedUrl(appToken, sourceUrl) {
    const domain = sourceUrl ? new URL(sourceUrl).hostname : this.config.tenantDomain;
    return `https://${domain}/base/${appToken}`;
  }

  async getMeta(token, docType = 'bitable') {
    const data = await this.request('/open-apis/drive/v1/metas/batch_query', {
      method: 'POST',
      data: {
        request_docs: [{ doc_token: token, doc_type: docType }],
        with_url: true,
      },
    });
    return (data.metas || [])[0] || {};
  }

  getCell(row, headers, names) {
    const normalized = headers.map((header) => valueToText(header).replace(/\s+/g, '').toLowerCase());
    for (const name of names) {
      const key = name.replace(/\s+/g, '').toLowerCase();
      const index = normalized.indexOf(key);
      if (index >= 0) return row[index];
    }
    return '';
  }

  normalizeAdsRow(row, headers, index) {
    return normalizeCommon({
      sourceRow: index + 2,
      date: valueToText(this.getCell(row, headers, FIELD.date)),
      project: valueToText(this.getCell(row, headers, FIELD.project)),
      code: valueToText(this.getCell(row, headers, FIELD.code)),
      shooter: valueToText(this.getCell(row, headers, FIELD.shooter)),
      country: valueToText(this.getCell(row, headers, FIELD.country)),
      kpi: this.getCell(row, headers, FIELD.kpi),
      crawlStatus: valueToText(this.getCell(row, headers, FIELD.crawlStatus)),
      metrics: {
        spend: valueToNumber(this.getCell(row, headers, FIELD.spend)),
        impressions: valueToNumber(this.getCell(row, headers, FIELD.impressions)),
        clicks: valueToNumber(this.getCell(row, headers, FIELD.clicks)),
        registrations: valueToNumber(this.getCell(row, headers, FIELD.registrations)),
        firstDeposits: valueToNumber(this.getCell(row, headers, FIELD.firstDeposits)),
      },
    });
  }

  normalizeRecord(record, position) {
    const fields = record.fields || {};
    return normalizeCommon({
      position,
      recordId: record.record_id,
      fields,
      project: valueToText(fields['项目'] ?? fields['项目名称']),
      code: valueToText(fields.Code ?? fields.code ?? fields.CODE),
      shooter: valueToText(fields['投手']),
      country: valueToText(fields['国家']),
      kpi: fields['KPI(美金）'] ?? fields.KPI ?? fields['KPI'],
      currentMetrics: {
        spend: valueToNumber(fields['花费金额']),
        impressions: valueToNumber(fields['展示次数']),
        clicks: valueToNumber(fields['点击量']),
        registrations: valueToNumber(fields['注册人数']),
        firstDeposits: valueToNumber(fields['首存人数']),
      },
    });
  }

  async resolveSpreadsheetToken(rawUrl) {
    const parsed = new URL(rawUrl);
    if (parsed.pathname.includes('/wiki/')) {
      const nodeData = await this.request('/open-apis/wiki/v2/spaces/get_node', {
        method: 'GET',
        params: { token: this.wikiToken(rawUrl) },
      });
      const token = nodeData.node && nodeData.node.obj_token;
      if (!token) throw new Error('Wiki node did not return spreadsheet token');
      return token;
    }
    if (parsed.pathname.includes('/sheets/')) {
      return parsed.pathname.split('/').filter(Boolean).at(-1);
    }
    throw new Error('Raw data URL must be a wiki or sheets link');
  }

  async readAdsRows(rawUrl) {
    const spreadsheetToken = await this.resolveSpreadsheetToken(rawUrl);
    const sheetsData = await this.request(`/open-apis/sheets/v3/spreadsheets/${encodeURIComponent(spreadsheetToken)}/sheets/query`, {
      method: 'GET',
    });
    const firstSheet = (sheetsData.sheets || [])[0];
    if (!firstSheet) throw new Error('Raw workbook has no sheet');
    const sheetId = firstSheet.sheet_id || firstSheet.sheetId;
    const valuesData = await this.request(
      `/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(spreadsheetToken)}/values/${encodeURIComponent(`${sheetId}!A1:AC5000`)}`,
      { method: 'GET' }
    );
    const values = valuesData.valueRange && valuesData.valueRange.values ? valuesData.valueRange.values : [];
    return this.readAdsRowsFromValues(values);
  }

  readAdsRowsFromValues(values) {
    const headers = values[0] || [];
    return values
      .slice(1)
      .filter((row) => row.some((value) => valueToText(value).trim() !== ''))
      .map((row, index) => this.normalizeAdsRow(row, headers, index))
      .filter((row) => row.project || row.code || row.shooter);
  }

  readAdsRowsFromXlsx(filePath) {
    const output = execFileSync(this.config.pythonExe, [path.join(__dirname, 'read_xlsx_values.py'), filePath], {
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
    });
    return this.readAdsRowsFromValues(JSON.parse(output));
  }

  async listTables(appToken) {
    const data = await this.request(`/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables`, {
      method: 'GET',
    });
    return data.items || [];
  }

  async listFields(appToken, tableId) {
    const data = await this.request(
      `/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/fields`,
      { method: 'GET', params: { page_size: 200 } }
    );
    return data.items || [];
  }

  async listViews(appToken, tableId) {
    const views = [];
    let pageToken;
    do {
      const data = await this.request(
        `/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/views`,
        { method: 'GET', params: { page_size: 100, page_token: pageToken } }
      );
      views.push(...(data.items || []));
      pageToken = data.has_more ? data.page_token : undefined;
    } while (pageToken);
    return views;
  }

  async createView(appToken, tableId, viewName, viewType = 'grid') {
    const data = await this.request(
      `/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/views`,
      {
        method: 'POST',
        data: {
          view_name: viewName,
          view_type: viewType,
        },
      }
    );
    return data.view || data;
  }

  async ensureGridViews(appToken, tableId, viewNames) {
    const existing = await this.listViews(appToken, tableId);
    const existingNames = new Set(existing.map((view) => view.view_name));
    const created = [];
    for (const viewName of viewNames) {
      if (existingNames.has(viewName)) continue;
      const view = await this.createView(appToken, tableId, viewName, 'grid');
      created.push(view);
      existingNames.add(viewName);
    }
    return { existing, created };
  }

  async listRecords(appToken, tableId) {
    const records = [];
    let pageToken;
    do {
      const data = await this.request(
        `/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/records`,
        { method: 'GET', params: { page_size: 500, page_token: pageToken } }
      );
      records.push(...(data.items || []));
      pageToken = data.has_more ? data.page_token : undefined;
    } while (pageToken);
    return records;
  }

  async readFirstBitable(url) {
    const appToken = this.appToken(url);
    const tables = await this.listTables(appToken);
    const table = tables[0];
    if (!table) throw new Error('Bitable has no table');
    const fields = await this.listFields(appToken, table.table_id);
    const rawRecords = await this.listRecords(appToken, table.table_id);
    const records = rawRecords.map((record, index) => this.normalizeRecord(record, index + 1));
    return { appToken, table, fields, records };
  }

  async readBitableTable(appToken, tableId) {
    const tables = await this.listTables(appToken);
    const table = tables.find((item) => item.table_id === tableId);
    if (!table) throw new Error(`Bitable table not found: ${tableId}`);
    const fields = await this.listFields(appToken, table.table_id);
    const rawRecords = await this.listRecords(appToken, table.table_id);
    const records = rawRecords.map((record, index) => this.normalizeRecord(record, index + 1));
    return { appToken, table, fields, rawRecords, records };
  }

  async readBitableTableByName(url, tableName) {
    const appToken = this.appToken(url);
    const tables = await this.listTables(appToken);
    const table = tables.find((item) => item.name === tableName);
    if (!table) throw new Error(`Bitable table not found: ${tableName}`);
    return this.readBitableTable(appToken, table.table_id);
  }

  async rootFolderToken() {
    const data = await this.request('/open-apis/drive/explorer/v2/root_folder/meta', { method: 'GET' });
    if (!data.token) throw new Error('Root folder token not found');
    return data.token;
  }

  async copyBitable(sourceUrl, name, options = {}) {
    const sourceToken = this.appToken(sourceUrl);
    const folderToken = options.folderToken || this.config.outputFolderToken || await this.rootFolderToken();
    const data = await this.request(`/open-apis/drive/v1/files/${encodeURIComponent(sourceToken)}/copy`, {
      method: 'POST',
      params: { type: 'bitable' },
      data: { name, type: 'bitable', folder_token: folderToken },
    });
    const candidates = [
      data.file && data.file.token,
      data.file && data.file.file_token,
      data.token,
      data.file_token,
      data.app && data.app.app_token,
      data.app_token,
    ].filter(Boolean);
    const copiedAppToken = candidates[0];
    if (!copiedAppToken) throw new Error(`Copy succeeded but app token was not recognized: ${JSON.stringify(data)}`);
    return { copiedAppToken, copiedUrl: this.copiedUrl(copiedAppToken, sourceUrl), raw: data };
  }

  async setTenantEditable(appToken) {
    return this.request(`/open-apis/drive/v1/permissions/${encodeURIComponent(appToken)}/public`, {
      method: 'PATCH',
      params: { type: 'bitable' },
      data: {
        external_access: false,
        security_entity: 'anyone_can_view',
        comment_entity: 'anyone_can_view',
        share_entity: 'anyone',
        link_share_entity: 'tenant_editable',
      },
    });
  }

  async grantOpenIdEdit(appToken, openId) {
    if (!openId) return { ok: false, skipped: true, reason: 'missing openId' };
    try {
      const data = await this.request(`/open-apis/drive/v1/permissions/${encodeURIComponent(appToken)}/members`, {
        method: 'POST',
        params: { type: 'bitable' },
        data: {
          member_type: 'openid',
          member_id: openId,
          perm: 'edit',
        },
      });
      return { ok: true, data };
    } catch (error) {
      return { ok: false, details: error.details || { message: error.message } };
    }
  }

  async grantOpenChatEdit(appToken, chatId) {
    if (!chatId) return { ok: false, skipped: true, reason: 'missing chatId' };
    const member = {
      member_type: 'openchat',
      member_id: chatId,
      perm: 'edit',
      type: 'chat',
    };

    try {
      const data = await this.request(`/open-apis/drive/v1/permissions/${encodeURIComponent(appToken)}/members`, {
        method: 'POST',
        params: { type: 'bitable' },
        data: member,
      });
      return { ok: true, action: 'create', data };
    } catch (createError) {
      try {
        const data = await this.request(
          `/open-apis/drive/v1/permissions/${encodeURIComponent(appToken)}/members/${encodeURIComponent(chatId)}`,
          {
            method: 'PUT',
            params: { type: 'bitable', member_type: 'openchat' },
            data: {
              perm: 'edit',
              type: 'chat',
            },
          }
        );
        return { ok: true, action: 'update', data };
      } catch (updateError) {
        return {
          ok: false,
          action: 'create_or_update',
          createDetails: createError.details || { message: createError.message },
          updateDetails: updateError.details || { message: updateError.message },
        };
      }
    }
  }

  async grantResultChatEdit(appToken, chatId = this.config.permissionChatId || this.config.resultChatId) {
    return this.grantOpenChatEdit(appToken, chatId);
  }

  async grantSourceOwnerEdit(sourceUrl, copiedAppToken) {
    const sourceToken = this.appToken(sourceUrl);
    const sourceMeta = await this.getMeta(sourceToken, 'bitable');
    const targetOpenId = sourceMeta.owner_id || sourceMeta.latest_modify_user;
    const grantResult = await this.grantOpenIdEdit(copiedAppToken, targetOpenId);
    return {
      sourceMeta,
      targetOpenId,
      grantResult,
    };
  }

  async batchUpdateRecords(appToken, tableId, updates) {
    for (let index = 0; index < updates.length; index += 500) {
      const chunk = updates.slice(index, index + 500);
      await this.request(
        `/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/records/batch_update`,
        { method: 'POST', data: { records: chunk } }
      );
    }
  }

  async batchDeleteRecords(appToken, tableId, recordIds) {
    for (let index = 0; index < recordIds.length; index += 500) {
      const chunk = recordIds.slice(index, index + 500);
      if (!chunk.length) continue;
      await this.request(
        `/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/records/batch_delete`,
        { method: 'POST', data: { records: chunk } }
      );
    }
  }

  async createTable(appToken, name, fields, options = {}) {
    const data = await this.request(`/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/batch_create`, {
      method: 'POST',
      data: {
        tables: [
          {
            name,
            default_view_name: options.defaultViewName || '表格',
            fields,
          },
        ],
      },
    });
    const tableId = data.table_id || (data.table_ids && data.table_ids[0]);
    if (!tableId) throw new Error(`Create table succeeded but table id was not recognized: ${JSON.stringify(data)}`);
    return { table_id: tableId, raw: data };
  }

  async createField(appToken, tableId, field) {
    const data = await this.request(
      `/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/fields`,
      {
        method: 'POST',
        data: field,
      }
    );
    return data.field || data;
  }

  async updateField(appToken, tableId, fieldId, field) {
    const data = await this.request(
      `/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/fields/${encodeURIComponent(fieldId)}`,
      {
        method: 'PUT',
        data: field,
      }
    );
    return data.field || data;
  }

  async deleteTable(appToken, tableId) {
    return this.request(`/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}`, {
      method: 'DELETE',
    });
  }

  async renameTable(appToken, tableId, name) {
    return this.request(`/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}`, {
      method: 'PATCH',
      data: { name },
    });
  }

  async batchCreateRecords(appToken, tableId, records) {
    for (let index = 0; index < records.length; index += 500) {
      const chunk = records.slice(index, index + 500);
      await this.request(
        `/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/records/batch_create`,
        { method: 'POST', data: { records: chunk } }
      );
    }
  }

  async replyText(messageId, text) {
    return this.request(`/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reply`, {
      method: 'POST',
      data: {
        msg_type: 'text',
        content: JSON.stringify({ text }),
      },
    });
  }

  async sendTextToChat(chatId, text) {
    return this.request('/open-apis/im/v1/messages', {
      method: 'POST',
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'text',
        content: JSON.stringify({ text }),
      },
    });
  }

  async uploadImFile(filePath, options = {}) {
    const fileName = options.fileName || path.basename(filePath);
    const form = new FormData();
    form.append('file_type', options.fileType || 'stream');
    form.append('file_name', fileName);
    form.append('file', fs.createReadStream(filePath));

    try {
      const response = await client.request({
        url: `${this.config.baseUrl}/open-apis/im/v1/files`,
        method: 'POST',
        headers: {
          Authorization: this.headers.Authorization,
          ...form.getHeaders(),
        },
        data: form,
        maxBodyLength: Infinity,
      });
      if (!response.data || response.data.code !== 0 || !response.data.data || !response.data.data.file_key) {
        const error = new Error('Failed to upload IM file');
        error.response = { status: response.status, data: response.data };
        throw error;
      }
      return response.data.data.file_key;
    } catch (error) {
      const wrapped = new Error(`API failed: upload IM file ${fileName}`);
      wrapped.details = apiError('/open-apis/im/v1/files', error);
      throw wrapped;
    }
  }

  async sendFileToChat(chatId, filePath, options = {}) {
    const fileKey = await this.uploadImFile(filePath, options);
    return this.request('/open-apis/im/v1/messages', {
      method: 'POST',
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'file',
        content: JSON.stringify({ file_key: fileKey }),
      },
    });
  }

  buildMetricUpdate(match) {
    const fields = {};
    for (const [metric, field] of Object.entries(TARGET_METRIC_FIELDS)) {
      fields[field] = match.ad.metrics[metric] ?? 0;
    }
    return {
      record_id: match.record.recordId,
      fields,
    };
  }
}

module.exports = {
  FeishuClient,
  TARGET_METRIC_FIELDS,
};
