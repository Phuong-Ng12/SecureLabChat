const ROOMS = ['#general', '#announcements'];

const ROLES = ['Admin', 'Manager', 'Supervisor', 'Staff'];

// A department channel has primary key which is the department id, so two similar names can
// never clash. The visible name comes from the departments table.
function departmentRoom(departmentId) {
    return `#dept-${departmentId}`;
}

function canAccessAllDepartments(role) {
    return role === 'Admin' || role === 'Manager';
}

// Server-side posting rules (the browser check is only cosmetic)
function canPost(role, room, departmentId) {
    if (room === '#announcements') return canAccessAllDepartments(role);
    if (room === '#general') return ['Manager', 'Admin', 'Supervisor'].includes(role);

    // The server checks that the department exists before using this rule.
    if (typeof room !== 'string' || !/^#dept-[1-9]\d*$/.test(room)) return false;
    return canAccessAllDepartments(role) ||
        (role === 'Supervisor' && departmentId != null && room === departmentRoom(departmentId));
}

module.exports = { ROOMS, ROLES, departmentRoom, canAccessAllDepartments, canPost };
