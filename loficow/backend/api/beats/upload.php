<?php
$user = requireAuth();
$body = json_decode(file_get_contents('php://input'), true) ?? [];

$title    = trim($body['title'] ?? '');
$audioUrl = $body['audio_url'] ?? null;
$coverUrl = $body['cover_url'] ?? null;
$bpm      = $body['bpm'] ? (int)$body['bpm'] : null;
$key      = $body['key'] ?? null;
$mood     = $body['mood'] ?? null;
$tags     = $body['tags'] ?? null;
$genre    = $body['genre'] ?? 'lofi';
$pBasic   = $body['price_basic'] ? (float)$body['price_basic'] : null;
$pPrem    = $body['price_premium'] ? (float)$body['price_premium'] : null;
$pExcl    = $body['price_exclusive'] ? (float)$body['price_exclusive'] : null;
$isFree   = (bool)($body['is_free'] ?? false);

if (!$title || !$audioUrl) error('Title and audio required');

$db = getDB();
$stmt = $db->prepare('
    INSERT INTO beats (user_id, title, audio_url, cover_url, bpm, `key`, mood, tags, genre, price_basic, price_premium, price_exclusive, is_free)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
');
$stmt->execute([
    $user['id'], $title, $audioUrl, $coverUrl, $bpm, $key, $mood,
    is_array($tags) ? implode(',', $tags) : $tags,
    $genre, $pBasic, $pPrem, $pExcl, (int)$isFree,
]);
$beatId = (int)$db->lastInsertId();

$beat = $db->query("
    SELECT b.*, u.username, u.display_name, u.avatar_url
    FROM beats b JOIN users u ON u.id = b.user_id WHERE b.id = $beatId
")->fetch();

json(['beat' => $beat], 201);
