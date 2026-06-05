<?php
$body = json_decode(file_get_contents('php://input'), true) ?? [];

$username    = trim($body['username'] ?? '');
$email       = trim($body['email'] ?? '');
$password    = $body['password'] ?? '';
$displayName = trim($body['display_name'] ?? $username);
$accountType = $body['account_type'] ?? 'artist';

if (!$username || !$email || !$password) error('All fields required');
if (!filter_var($email, FILTER_VALIDATE_EMAIL)) error('Invalid email');
if (strlen($password) < 8) error('Password must be at least 8 characters');
if (!preg_match('/^[a-zA-Z0-9_]{3,50}$/', $username)) error('Username must be 3-50 chars, letters/numbers/underscores only');
if (!in_array($accountType, ['artist', 'label', 'both'])) error('Invalid account type');

$db = getDB();

$check = $db->prepare('SELECT id FROM users WHERE email = ? OR username = ? LIMIT 1');
$check->execute([$email, $username]);
if ($check->fetch()) error('Email or username already taken');

$hash = password_hash($password, PASSWORD_BCRYPT, ['cost' => 12]);
$stmt = $db->prepare('
    INSERT INTO users (username, email, password, display_name, account_type)
    VALUES (?, ?, ?, ?, ?)
');
$stmt->execute([$username, $email, $hash, $displayName, $accountType]);
$userId = (int)$db->lastInsertId();

$token = bin2hex(random_bytes(32));
$expires = date('Y-m-d H:i:s', strtotime('+30 days'));
$tokenStmt = $db->prepare('INSERT INTO auth_tokens (user_id, token, expires_at) VALUES (?, ?, ?)');
$tokenStmt->execute([$userId, $token, $expires]);

$user = $db->query("SELECT id, username, email, display_name, account_type, avatar_url, verified FROM users WHERE id = $userId")->fetch();

json(['token' => $token, 'user' => $user], 201);
