$ErrorActionPreference = 'Stop'
$WarningPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
$InformationPreference = 'SilentlyContinue'
$script:connected = $false

function Fail([int]$status, [string]$message) {
    throw "$status|$message"
}

function Connect-Exchange {
    if ($script:connected) { return }
    Import-Module ExchangeOnlineManagement -ErrorAction Stop
    if ($env:EXO_AUTH -eq 'managed_identity') {
        Connect-ExchangeOnline -ManagedIdentity -Organization $env:EXO_ORGANIZATION -ShowBanner:$false -ErrorAction Stop | Out-Null
    } elseif ($env:EXO_AUTH -eq 'certificate') {
        $cert = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new($env:EXO_CERT_PATH, $env:EXO_CERT_PASSWORD)
        Connect-ExchangeOnline -Certificate $cert -AppId $env:EXO_APP_ID -Organization $env:EXO_ORGANIZATION -ShowBanner:$false -ErrorAction Stop | Out-Null
    } else {
        Fail 500 'Exchange authentication is not configured.'
    }
    $script:connected = $true
}

function Resolve-Actor($actor) {
    if (-not $actor.oid -or $actor.oid -notmatch '^[0-9a-fA-F-]{36}$') { Fail 401 'Invalid user identity.' }
    $person = Get-EXORecipient -ExternalDirectoryObjectId $actor.oid -Properties DisplayName,PrimarySmtpAddress,RecipientTypeDetails -ErrorAction SilentlyContinue
    if (-not $person -or [string]$person.RecipientTypeDetails -notin @('UserMailbox','MailUser')) {
        Fail 403 'Your account does not have an Exchange mailbox.'
    }
    return $person
}

function Resolve-Person([string]$email) {
    if (-not $email -or $email -notmatch '^[^@\s]+@[^@\s]+\.[^@\s]+$') { Fail 400 'Invalid person address.' }
    $person = Get-EXORecipient -PrimarySmtpAddress $email -Properties DisplayName,PrimarySmtpAddress,RecipientTypeDetails -ErrorAction SilentlyContinue
    if (-not $person -or [string]$person.RecipientTypeDetails -notin @('UserMailbox','MailUser')) {
        Fail 400 "Person not found in the tenant directory: $email"
    }
    return $person
}

function Resolve-Group([string]$id) {
    if (-not $id -or $id -notmatch '^[^@\s]+@[^@\s]+\.[^@\s]+$') { Fail 400 'Invalid list address.' }
    $group = Get-DistributionGroup -Identity $id -ErrorAction SilentlyContinue
    if (-not $group -or [string]$group.RecipientTypeDetails -ne 'MailUniversalDistributionGroup') {
        Fail 404 'Distribution list not found.'
    }
    return $group
}

function Is-Owner($group, $person) {
    $owned = @(Get-DistributionGroup -ManagedBy ([string]$person.PrimarySmtpAddress) -ResultSize Unlimited -ErrorAction Stop)
    return [bool](@($owned | Where-Object { [string]$_.PrimarySmtpAddress -ieq [string]$group.PrimarySmtpAddress }).Count)
}

function Require-Owner($group, $person) {
    if ($group.IsDirSynced) { Fail 403 'This list is managed from on-premises and cannot be changed here.' }
    if (-not (Is-Owner $group $person)) { Fail 403 'Only a list owner can make this change.' }
}

function Group-Summary($group, $person, $members = $null, $includeMembers = $false, $ownerOverride = $null) {
    $specific = @($group.AcceptMessagesOnlyFromSendersOrMembers | Where-Object { $_ }).Count -gt 0
    $owner = if ($null -eq $ownerOverride) { Is-Owner $group $person } else { [bool]$ownerOverride }
    $policy = if ($specific) { 'specific' } elseif ($group.RequireSenderAuthenticationEnabled) { 'internal' } else { 'anyone' }
    $joined = $null
    $count = $null
    if ($includeMembers) {
        $count = @($members).Count
        $joined = [bool](@($members | Where-Object { [string]$_.PrimarySmtpAddress -ieq [string]$person.PrimarySmtpAddress }).Count)
    }
    return @{
        id = [string]$group.PrimarySmtpAddress
        displayName = [string]$group.DisplayName
        alias = [string]$group.Alias
        senderPolicy = $policy
        visible = -not [bool]$group.HiddenFromAddressListsEnabled
        joinPolicy = switch ([string]$group.MemberJoinRestriction) { 'Open' { 'open' } 'ApprovalRequired' { 'approval' } default { 'closed' } }
        departOpen = [string]$group.MemberDepartRestriction -eq 'Open'
        synced = [bool]$group.IsDirSynced
        isOwner = $owner
        canManage = $owner -and -not [bool]$group.IsDirSynced
        isMember = $joined
        memberCount = $count
    }
}

function Groups-For-Member($person) {
    $recipient = Get-Recipient -Identity ([string]$person.PrimarySmtpAddress) -ErrorAction Stop
    $dn = [string]$recipient.DistinguishedName
    if (-not $dn) { Fail 502 'Could not look up your list memberships.' }
    $escapedDn = $dn.Replace("'", "''")
    return ,@(Get-DistributionGroup -Filter "Members -eq '$escapedDn'" -ResultSize Unlimited -ErrorAction Stop | Where-Object {
        [string]$_.RecipientTypeDetails -eq 'MailUniversalDistributionGroup'
    })
}

function Owner-Emails($group) {
    $addresses = @()
    foreach ($owner in @($group.ManagedBy)) {
        try {
            $recipient = Get-Recipient -Identity $owner -ErrorAction Stop
            if ($recipient.PrimarySmtpAddress) { $addresses += [string]$recipient.PrimarySmtpAddress }
        } catch { }
    }
    return $addresses
}

function Run-Operation($request) {
    Connect-Exchange
    $actor = Resolve-Actor $request.actor
    $op = [string]$request.op
    $data = $request.data
    switch ($op) {
        'me' {
            return @{ name = [string]$actor.DisplayName; email = [string]$actor.PrimarySmtpAddress }
        }
        'owned' {
            $groups = @(Get-DistributionGroup -ManagedBy ([string]$actor.PrimarySmtpAddress) -ResultSize Unlimited | Where-Object { [string]$_.RecipientTypeDetails -eq 'MailUniversalDistributionGroup' })
            return ,@($groups | ForEach-Object { Group-Summary $_ $actor $null $false $true })
        }
        'joined' {
            $groups = @(Groups-For-Member $actor)
            $owned = @(Get-DistributionGroup -ManagedBy ([string]$actor.PrimarySmtpAddress) -ResultSize Unlimited)
            $ownedEmails = @($owned | ForEach-Object { [string]$_.PrimarySmtpAddress })
            return ,@($groups | ForEach-Object {
                $out = Group-Summary $_ $actor $null $false ([string]$_.PrimarySmtpAddress -in $ownedEmails)
                $out.isMember = $true
                $out
            })
        }
        'discover' {
            $q = [string]$data.q
            if ($q.Length -ge 2) { $groups = @(Get-DistributionGroup -Anr $q -ResultSize 300) }
            else { $groups = @(Get-DistributionGroup -ResultSize 1000) }
            $owned = @(Get-DistributionGroup -ManagedBy ([string]$actor.PrimarySmtpAddress) -ResultSize Unlimited)
            $ownedEmails = @($owned | ForEach-Object { [string]$_.PrimarySmtpAddress })
            $joinedEmails = @((Groups-For-Member $actor) | ForEach-Object { [string]$_.PrimarySmtpAddress })
            $groups = @($groups | Where-Object {
                [string]$_.PrimarySmtpAddress -notin $ownedEmails -and
                [string]$_.PrimarySmtpAddress -notin $joinedEmails -and
                [string]$_.RecipientTypeDetails -eq 'MailUniversalDistributionGroup' -and
                -not $_.HiddenFromAddressListsEnabled -and
                [string]$_.MemberJoinRestriction -in @('Open','ApprovalRequired') -and
                ($q.Length -lt 2 -or ($_.DisplayName + ' ' + $_.PrimarySmtpAddress).ToLower().Contains($q.ToLower()))
            } | Select-Object -First 100)
            return ,@($groups | ForEach-Object {
                $out = Group-Summary $_ $actor $null $false $false
                $out.isMember = $false
                $out
            })
        }
        'alias' {
            $alias = [string]$data.alias
            if ($alias -notmatch '^[a-z0-9][a-z0-9-]{2,39}$') { Fail 400 'Invalid alias.' }
            $taken = @(Get-Recipient -Filter "Alias -eq '$alias'" -ResultSize 1)
            return @{ available = ($taken.Count -eq 0) }
        }
        'directory' {
            $q = [string]$data.q
            if ($q.Length -lt 2 -or $q.Length -gt 80) { Fail 400 'Enter 2 to 80 characters.' }
            $people = @(Get-EXORecipient -Anr $q -RecipientTypeDetails UserMailbox,MailUser -ResultSize 8)
            return ,@($people | ForEach-Object { @{ name = [string]$_.DisplayName; email = [string]$_.PrimarySmtpAddress } })
        }
        'get' {
            $group = Resolve-Group ([string]$data.id)
            $members = @(Get-DistributionGroupMember -Identity $group.Identity -ResultSize Unlimited)
            $out = Group-Summary $group $actor $members $true
            $out.owners = @(Owner-Emails $group)
            if ($out.canManage) {
                $out.members = @($members | ForEach-Object { @{ name = [string]$_.DisplayName; email = [string]$_.PrimarySmtpAddress } })
                $out.senders = @($group.AcceptMessagesOnlyFromSendersOrMembers | ForEach-Object {
                    try { [string](Get-Recipient -Identity $_ -ErrorAction Stop).PrimarySmtpAddress } catch { }
                })
            }
            return $out
        }
        'create' {
            $alias = [string]$data.alias
            if ($alias -notmatch '^[a-z0-9][a-z0-9-]{2,39}$') { Fail 400 'Invalid alias.' }
            $email = "$alias@$env:MAIL_DOMAIN"
            $taken = @(Get-Recipient -Filter "Alias -eq '$alias'" -ResultSize 1)
            if ($taken.Count) { Fail 409 'That list address is already in use.' }
            $members = @($data.members | ForEach-Object { [string](Resolve-Person ([string]$_)).PrimarySmtpAddress })
            $owners = @([string]$actor.PrimarySmtpAddress)
            if ($data.coOwner) {
                $co = [string](Resolve-Person ([string]$data.coOwner)).PrimarySmtpAddress
                if ($co -ine $owners[0]) { $owners += $co }
            }
            $senders = @()
            if ($data.senderPolicy -eq 'specific') {
                $senders = @($data.senders | ForEach-Object { [string](Resolve-Person ([string]$_)).PrimarySmtpAddress })
                if (-not $senders.Count) { Fail 400 'Add at least one allowed sender.' }
            }
            $join = switch ([string]$data.joinPolicy) { 'open' { 'Open' } 'approval' { 'ApprovalRequired' } default { 'Closed' } }
            $params = @{
                Name = [string]$data.displayName
                DisplayName = [string]$data.displayName
                Alias = $alias
                PrimarySmtpAddress = $email
                ManagedBy = $owners
                Type = 'Distribution'
                MemberJoinRestriction = $join
                MemberDepartRestriction = 'Open'
                RequireSenderAuthenticationEnabled = ($data.senderPolicy -ne 'anyone')
                ErrorAction = 'Stop'
            }
            $created = New-DistributionGroup @params
            $warnings = @()
            try {
                Set-DistributionGroup -Identity $created.Identity -HiddenFromAddressListsEnabled (-not [bool]$data.visible) -BypassSecurityGroupManagerCheck -ErrorAction Stop
            } catch {
                $warnings += 'The list was created, but address book visibility could not be applied. Check settings in Lists I own.'
            }
            if ($senders.Count) {
                try {
                    Set-DistributionGroup -Identity $created.Identity -AcceptMessagesOnlyFromSendersOrMembers $senders -BypassSecurityGroupManagerCheck -ErrorAction Stop
                } catch {
                    $warnings += 'The list was created, but the allowed senders could not be applied. Check settings in Lists I own.'
                }
            }
            foreach ($member in $members) {
                try {
                    Add-DistributionGroupMember -Identity $created.Identity -Member $member -BypassSecurityGroupManagerCheck -ErrorAction Stop
                } catch {
                    $warnings += "Could not add $member. Add this person from Lists I own."
                }
            }
            return @{
                id = $email
                displayName = [string]$data.displayName
                alias = $alias
                senderPolicy = [string]$data.senderPolicy
                visible = [bool]$data.visible
                joinPolicy = [string]$data.joinPolicy
                departOpen = $true
                synced = $false
                isOwner = $true
                canManage = $true
                isMember = ($members -contains [string]$actor.PrimarySmtpAddress)
                memberCount = $members.Count - ($warnings | Where-Object { $_ -like 'Could not add *' }).Count
                warnings = $warnings
            }
        }
        'update' {
            $group = Resolve-Group ([string]$data.id)
            Require-Owner $group $actor
            $params = @{ Identity = $group.Identity; BypassSecurityGroupManagerCheck = $true; ErrorAction = 'Stop' }
            if ($data.Contains('displayName')) { $params.DisplayName = [string]$data.displayName }
            if ($data.Contains('visible')) { $params.HiddenFromAddressListsEnabled = -not [bool]$data.visible }
            if ($data.Contains('joinPolicy')) {
                $params.MemberJoinRestriction = switch ([string]$data.joinPolicy) { 'open' { 'Open' } 'approval' { 'ApprovalRequired' } default { 'Closed' } }
            }
            if ($data.Contains('senderPolicy')) {
                $params.RequireSenderAuthenticationEnabled = $data.senderPolicy -ne 'anyone'
                if ($data.senderPolicy -eq 'specific') {
                    $senders = @($data.senders | ForEach-Object { [string](Resolve-Person ([string]$_)).PrimarySmtpAddress })
                    if (-not $senders.Count) { Fail 400 'Add at least one allowed sender.' }
                    $params.AcceptMessagesOnlyFromSendersOrMembers = $senders
                } else {
                    $params.AcceptMessagesOnlyFromSendersOrMembers = $null
                }
            }
            if ($params.Count -gt 3) { Set-DistributionGroup @params }
            if ($data.coOwner) {
                $co = [string](Resolve-Person ([string]$data.coOwner)).PrimarySmtpAddress
                Set-DistributionGroup -Identity $group.Identity -ManagedBy @{Add=$co} -BypassSecurityGroupManagerCheck -ErrorAction Stop
            }
            return Group-Summary (Resolve-Group ([string]$data.id)) $actor $null $false $true
        }
        'add_owner' {
            $group = Resolve-Group ([string]$data.id)
            Require-Owner $group $actor
            $newOwner = [string](Resolve-Person ([string]$data.email)).PrimarySmtpAddress
            if ($newOwner -in @(Owner-Emails $group)) { Fail 409 'This person is already an owner.' }
            Set-DistributionGroup -Identity $group.Identity -ManagedBy @{Add=$newOwner} -BypassSecurityGroupManagerCheck -ErrorAction Stop
            return Group-Summary (Resolve-Group ([string]$data.id)) $actor $null $false $true
        }
        { $_ -in @('add_member','remove_member','approve_request') } {
            $group = Resolve-Group ([string]$data.id)
            Require-Owner $group $actor
            $member = [string](Resolve-Person ([string]$data.email)).PrimarySmtpAddress
            if ($op -eq 'remove_member') {
                Remove-DistributionGroupMember -Identity $group.Identity -Member $member -BypassSecurityGroupManagerCheck -Confirm:$false -ErrorAction Stop
            } else {
                Add-DistributionGroupMember -Identity $group.Identity -Member $member -BypassSecurityGroupManagerCheck -ErrorAction Stop
            }
            return Group-Summary $group $actor $null $false $true
        }
        'membership' {
            $group = Resolve-Group ([string]$data.id)
            if ($group.IsDirSynced) { Fail 403 'This list is managed from on-premises.' }
            $member = [string]$actor.PrimarySmtpAddress
            $members = @(Get-DistributionGroupMember -Identity $group.Identity -ResultSize Unlimited)
            $joined = [bool](@($members | Where-Object { [string]$_.PrimarySmtpAddress -ieq $member }).Count)
            if ($data.action -eq 'join') {
                if ($joined) { return @{ joined = $true } }
                if ([string]$group.MemberJoinRestriction -eq 'Closed') { Fail 403 'This list is closed to self-service joining.' }
                if ([string]$group.MemberJoinRestriction -eq 'ApprovalRequired') { return @{ approvalRequired = $true } }
                Add-DistributionGroupMember -Identity $group.Identity -Member $member -BypassSecurityGroupManagerCheck -ErrorAction Stop
                return @{ joined = $true }
            }
            if ([string]$group.MemberDepartRestriction -ne 'Open') { Fail 403 'Only an owner can remove members from this list.' }
            if ($joined) {
                Remove-DistributionGroupMember -Identity $group.Identity -Member $member -BypassSecurityGroupManagerCheck -Confirm:$false -ErrorAction Stop
            }
            return @{ joined = $false }
        }
        default { Fail 400 'Unknown operation.' }
    }
}

while ($null -ne ($line = [Console]::ReadLine())) {
    try {
        $request = ConvertFrom-Json -InputObject $line -AsHashtable -ErrorAction Stop
        $result = Run-Operation $request
        $response = @{ ok = $true; data = $result }
    } catch {
        $message = [string]$_.Exception.Message
        $status = 502
        if ($message -match '^([0-9]{3})\|(.*)$') {
            $status = [int]$Matches[1]
            $message = $Matches[2]
        } else {
            $script:connected = $false
            $message = 'Exchange could not complete that action. Please try again or contact support.'
        }
        $response = @{ ok = $false; status = $status; error = $message }
    }
    [Console]::Out.WriteLine('DLSTUDIO_JSON:' + ($response | ConvertTo-Json -Depth 12 -Compress))
    [Console]::Out.Flush()
}
