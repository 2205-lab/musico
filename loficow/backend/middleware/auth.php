<?php
function requireAuth(): array {
    $headers = getallheaders();
    $authHeader = $headers['Authorization'] ?? $headers['authorization'] ?? '';
    if (!preg_match('/^Bearer\s+(.+)$/i', $authHeader, $m)) {
        error('Unauthorized', 401);
    }
    $token = $m[1];
    $db = getDB();
    $stmt = $db->prepare('
        SELECT u.* FROM users u
        JOIN auth_tokens t ON t.user_id = u.id
        WHERE t.token = ? AND t.expires_at > NOW()
        LIMIT 1
    ');
    $stmt->execute([$token]);
    $user = $stmt->fetch();
    if (!$user) error('Unauthorized', 401);
    return $user;
}

function optionalAuth(): ?array {
    $headers = getallheaders();
    $authHeader = $headers['Authorization'] ?? $headers['authorization'] ?? '';
    if (!preg_match('/^Bearer\s+(.+)$/i', $authHeader, $m)) return null;
    $token = $m[1];
    try {
        $db = getDB();
        $stmt = $db->prepare('
            SELECT u.* FROM users u
            JOIN auth_tokens t ON t.user_id = u.id
            WHERE t.token = ? AND t.expires_at > NOW()
            LIMIT 1
        ');
        $stmt->execute([$token]);
        return $stmt->fetch() ?: null;
    } catch (Exception) {
        return null;
    }
}
