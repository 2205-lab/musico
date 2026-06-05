<?php
$user = requireAuth();
$body = json_decode(file_get_contents('php://input'), true) ?? [];

$labelId    = (int)($body['label_id'] ?? 0);
$trackTitle = trim($body['track_title'] ?? '');
$audioUrl   = $body['audio_url'] ?? null;
$coverUrl   = $body['cover_url'] ?? null;
$message    = trim($body['message'] ?? '');

if (!$labelId || !$trackTitle || !$audioUrl) error('Label, track title, and audio required');

$db = getDB();
$label = $db->query("SELECT id, account_type FROM users WHERE id = $labelId")->fetch();
if (!$label || !in_array($label['account_type'], ['label','both'])) error('Target is not a label', 404);

$stmt = $db->prepare('
    INSERT INTO submissions (artist_id, label_id, track_title, audio_url, cover_url, message)
    VALUES (?, ?, ?, ?, ?, ?)
');
$stmt->execute([$user['id'], $labelId, $trackTitle, $audioUrl, $coverUrl, $message ?: null]);
$subId = (int)$db->lastInsertId();

$db->prepare('INSERT INTO notifications (user_id, from_user_id, type, reference_id, reference_type) VALUES (?,?,?,?,?)')
   ->execute([$labelId, $user['id'], 'submission', $subId, 'submission']);

json(['submission_id' => $subId], 201);
