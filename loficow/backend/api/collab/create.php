<?php
$user = requireAuth();
$body = json_decode(file_get_contents('php://input'), true) ?? [];

$title       = trim($body['title'] ?? '');
$description = trim($body['description'] ?? '');
$lookingFor  = $body['looking_for'] ?? '';
$tags        = $body['tags'] ?? null;
$audioSample = $body['audio_sample_url'] ?? null;

if (!$title || !$description || !$lookingFor) error('Title, description, and looking_for are required');

$db = getDB();
$stmt = $db->prepare('
    INSERT INTO collabs (user_id, title, description, looking_for, tags, audio_sample_url)
    VALUES (?, ?, ?, ?, ?, ?)
');
$stmt->execute([
    $user['id'], $title, $description,
    is_array($lookingFor) ? implode(',', $lookingFor) : $lookingFor,
    is_array($tags) ? implode(',', $tags) : $tags,
    $audioSample,
]);
$id = (int)$db->lastInsertId();

$collab = $db->query("
    SELECT c.*, u.username, u.display_name, u.avatar_url
    FROM collabs c JOIN users u ON u.id = c.user_id WHERE c.id = $id
")->fetch();

json(['collab' => $collab], 201);
