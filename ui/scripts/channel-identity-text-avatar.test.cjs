const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const vm = require('node:vm')
const ts = require('typescript')

const loadTypeScript = (relativePath) => {
  const filename = path.join(__dirname, relativePath)
  const loaded = new Module(filename, module)
  loaded.filename = filename
  loaded.paths = module.paths
  loaded._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText, filename)
  return loaded.exports
}
const { normalizeAvatarTextStyle } = loadTypeScript('../src/utils/channelIdentityAvatar.ts')
const { normalizeIdentityExportFileForImport } = loadTypeScript('../src/utils/channelIdentityMigration.ts')
const version = 'sealchat.channel-identity/v5'
const payload = (avatar = {}) => ({
  version, generatedAt: '',
  items: [{ sourceId: 'actor', displayName: 'Actor', color: '#123456', isDefault: true, sortOrder: 1, ...avatar }],
})
const normalize = (value) => normalizeIdentityExportFileForImport(value, [version])

assert.equal(normalize(payload()).items[0].avatarTextStyle, '', 'old exports inherit the existing avatar behavior')
for (const style of ['a', 'b', 'c']) {
  const result = normalize(payload({ avatarTextStyle: style }))
  assert.equal(result.items[0].avatarTextStyle, style)
  assert.deepEqual(result.assets, [], 'text avatars need no avatar asset')
  assert.equal(normalizeAvatarTextStyle(style), style)
}
for (const style of ['d', 'A', ' a', 'generated:a', null]) {
  assert.throws(() => normalize(payload({ avatarTextStyle: style })), /无效文字头像样式/)
  assert.equal(normalizeAvatarTextStyle(style), '')
}
assert.throws(() => normalize(payload({ avatarTextStyle: 'a', avatarAssetKey: 'image' })), /不能同时/)

const snapshotSource = fs.readFileSync(path.join(__dirname, '../src/views/chat/components/message-image/messageImageSnapshot.ts'), 'utf8')
assert.match(snapshotSource, /sender_identity_avatar_text_style/, 'message image snapshot must read historical text-avatar style')
assert.match(snapshotSource, /buildGeneratedAvatarDataUrl/, 'message image snapshot must render text avatars instead of account avatars')
const searchSource = fs.readFileSync(path.join(__dirname, '../src/stores/channelSearch.ts'), 'utf8')
assert.match(searchSource, /identity:\s*normalizeSearchIdentity\(item\.identity\)/, 'search results must retain identity snapshots')

// Exercise the actual dialog handlers and save branch without mounting the chat page.
const chatSource = fs.readFileSync(path.join(__dirname, '../src/views/chat/chat.vue'), 'utf8')
assert.match(chatSource, /sender_identity_avatar_text_style:\s*item\.identity\?\.avatarTextStyle/, 'archived search must restore text-avatar snapshot fields')
const setup = chatSource.match(/<script setup[^>]*>([\s\S]*?)<\/script>/)[1]
const source = ts.createSourceFile('chat.ts', setup, ts.ScriptTarget.Latest, true)
const handlerNames = ['removeIdentityAvatar', 'enableIdentityTextAvatar', 'selectIdentityAvatarStyle', 'handleIdentityAvatarTrigger', 'handleIdentityAvatarEditorSave', 'handleIdentityAvatarEditorCancel', 'submitIdentityForm']
const handlers = source.statements.filter(statement => ts.isVariableStatement(statement)
  && statement.declarationList.declarations.some(declaration => handlerNames.includes(declaration.name.getText(source))))
assert.equal(handlers.length, handlerNames.length)
const submitted = []
let uploads = 0
let generations = 0
const context = {
  identityForm: { displayName: 'Actor', color: '#123456', avatarAttachmentId: 'old-image', avatarTextStyle: '', avatarDecorations: [], characterCardId: '', isTemporary: false },
  identityAvatarFile: { name: 'pending.png' }, identityAvatarFilePending: { value: true }, identityAvatarPreview: { value: 'blob:old' },
  identityGeneratedAvatarStyle: { value: 'b' }, identityAvatarInputRef: { value: { click() {} } },
  identityAvatarEditorVisible: { value: true }, identityAvatarEditorFile: { value: null },
  revokeIdentityObjectURL() { context.identityAvatarPreview.value = '' },
  URL: { createObjectURL: () => 'blob:new' },
  identitySubmitting: { value: false }, currentIdentityTargetUserId: { value: 'owner' },
  botBaseAppearanceInherited: { value: false }, editingIdentity: { value: null }, isManagingBotIdentity: { value: false },
  identityDialogMode: { value: 'create' }, identityDialogVisible: { value: true },
  cloneAvatarDecorations: value => value || [], commitIdentityColorDraft: () => true,
  chat: { curChannel: { id: 'channel' }, channelIdentityCreate: async value => { submitted.push(value); return { ...value, id: 'actor' } }, loadChannelIdentities: async () => {} },
  display: { palette: 'night', settings: {} },
  buildGeneratedAvatarFile: async () => { generations++; return { name: 'generated.png' } },
  uploadImageAttachment: async () => { uploads++; return { attachmentId: 'image' } },
  normalizeAttachmentId: value => value, resolveAttachmentUrl: value => value,
  message: { success() {}, warning() {}, error(value) { throw new Error(value) } },
  module: { exports: {} },
}
vm.runInNewContext(ts.transpileModule(handlers.map(handler => handler.getText(source)).join('\n')
  + `\nmodule.exports = { ${handlerNames.join(', ')} };`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText, context)
const dialog = context.module.exports
;(async () => {
  dialog.enableIdentityTextAvatar()
  assert.equal(context.identityForm.avatarTextStyle, 'b')
  assert.equal(context.identityForm.avatarAttachmentId, '')
  assert.equal(context.identityAvatarFile, null)
  assert.equal(context.identityAvatarFilePending.value, false)
  assert.equal(context.identityAvatarPreview.value, '')
  dialog.selectIdentityAvatarStyle('c')
  dialog.handleIdentityAvatarTrigger()
  dialog.handleIdentityAvatarEditorCancel()
  assert.equal(context.identityForm.avatarTextStyle, 'c', 'opening/cancelling upload preserves text mode')
  assert.equal(await dialog.submitIdentityForm(), true)
  assert.equal(submitted[0].avatarTextStyle, 'c')
  assert.equal(submitted[0].avatarAttachmentId, '')
  assert.equal(uploads, 0)
  assert.equal(generations, 0)
  await dialog.handleIdentityAvatarEditorSave({ name: 'new.png' })
  assert.equal(context.identityForm.avatarTextStyle, '')
  assert.equal(context.identityAvatarFilePending.value, true)
  dialog.removeIdentityAvatar()
  assert.equal(context.identityForm.avatarTextStyle, '')
  context.identityForm.isTemporary = true
  dialog.selectIdentityAvatarStyle('b')
  assert.equal(context.identityForm.avatarTextStyle, '', 'temporary avatars keep attachment mode')
  assert.equal(await dialog.submitIdentityForm(), true)
  assert.equal(generations, 1)
  assert.equal(uploads, 1)
  assert.equal(submitted[1].avatarAttachmentId, 'image')
  console.log('channel identity text avatar tests passed')
})().catch(error => { console.error(error); process.exitCode = 1 })
